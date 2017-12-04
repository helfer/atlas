/* Atlas high-level structure

Atlas optimstic writes:
- Enter the transaction into the transaction log (so we can undo it later), return a handle (commit, rollback)
- Pass down in writeInfo wether the write is optimsitic or not.
- If nothing in the object changed, return the same reference.
- If there's a new field, use set and get back an optimistic version.
  - must propagate optimistic updates up to the root to preserve referential equality
  - must link old object to the new optimstic version for consistency.
  - if an optimistic object is being written, put it in the optimistic index.
  - tag the graph node as optimsitic (just for book keeping)

Atlas optimsitic reads:
- Find the rootId in the optimstic index. If it's not there, try the normal index.
- Just do the rest of the reading as you usually would.
*/

import {
    print,
    FragmentDefinitionNode,
    DocumentNode,
    SelectionSetNode,
    SelectionNode,
    ArgumentNode,
    InlineFragmentNode,
    // NamedTypeNode,
    OperationDefinitionNode,
    FieldNode,
} from 'graphql';

// import { Map as ImmutableMap } from 'immutable';

// const _parents = Symbol.for('parent');

export interface SerializableObject {
    [key: string]: SerializableValue[] | SerializableValue;
}

export type JSONScalar = object;

export type SerializableValue = SerializableObject | Number | String | JSONScalar | null;

export interface ReadContext { // TODO: Rename this to Options.
    // query: DocumentNode;
    variables?: SerializableObject;
    context?: SerializableObject;
    rootId?: string; // default 'QUERY', can be things like 'Stack:5', 'QUERY/allStacks'
    isOptimistic?: boolean;
}

export type WriteContext = ReadContext;

// interface ProxyHandler {
//     get: (obj: GraphNode, name: string) => any;
// }

export type UnsubscribeFunction = () => void;

export interface Subscriber {
    next: (o: SerializableObject) => void;
    error?: (e: Error) => void;
    complete?: () => void;
}

export interface Observable {
    subscribe: (subscriber: Subscriber) => UnsubscribeFunction;
}

export interface TransactionInfo {
    id: number;
    subscribersToNotify: Subscriber[];
    isOptimistic: boolean;
}

export interface FragmentMap { [key: string]: FragmentDefinitionNode; }

export interface WriteInfo {
    variables: SerializableObject;
    context?: any;
    isOptimistic: boolean;
    fragmentDefinitions: FragmentMap;
    query: DocumentNode;
    rootId: string;
    txInfo: TransactionInfo;
}

export interface ReadInfo {
    variables: SerializableObject;
    context?: any;
    isOptimistic: boolean;
    query: DocumentNode;
    rootId: string;
    rootNode: GraphNode | undefined;
    fragmentDefinitions: FragmentMap;
}

export type NodeIndex = { [key: string]: GraphNode };

export const QUERY_ROOT_ID = 'QUERY';

export interface GraphNodeData {
    [key: string]: GraphNode | GraphNode[] | SerializableValue;
}

export class GraphNode {
    public parents: { node: GraphNode, key: string | number }[] = [];
    public indexEntry: { index: NodeIndex, optimisticIndex: NodeIndex, key: string };
    public subscribers: Subscriber[] = [];
    public optimisticSubscribers: Subscriber[] = [];
    protected data: GraphNodeData;
    private transactionId: number; // The transaction this node was written by.
    private isOptimistic: boolean;
    private newerVersion: GraphNode | undefined;
    private newerOptimsticVersion: GraphNode | undefined;

    public constructor(tx: TransactionInfo, data?: { [key: string]: GraphNode | GraphNode[] | SerializableValue }) {
        this.transactionId = tx.id;
        this.data = data || Object.create(null);
        this.isOptimistic = tx.isOptimistic;
    }


    public subscribe(s: Subscriber, optimistic = false) {
        if (optimistic) {
            this.optimisticSubscribers.push(s);
        } else {
            this.subscribers.push(s); // TODO: make this a set and not a list
        }
    }

    public unsubscribe(s: Subscriber) {
        this.subscribers = this.subscribers.filter(sub => sub !== s);
    }

    // Copy parents over from old node, creating a new reference of the parent where necessary
    // Also updates the index entry
    public adoptParents(previousNode: GraphNode, tx: TransactionInfo) {
        this.parents = previousNode.parents.map(parent => {
            return {
                node: parent.node.set(parent.key, this, tx),
                key: parent.key,
            };
        });
        this.indexEntry = previousNode.indexEntry;
        if (this.indexEntry) {
            if (tx.isOptimistic) {
                // throw new Error('Optimistic index update not implemented');
                // TODO: refactor the whole index handling. GraphNodes should know their
                // own ID, and they can perfectly well update the index. We just need
                // to give them a reference to it. Optimistic nodes update the optimistc
                // index, normal nodes update the normal index. It's as simple as that.
                this.indexEntry.optimisticIndex[this.indexEntry.key] = this;
            } else {
                this.indexEntry.index[this.indexEntry.key] = this;
            }
        }
    }

    // TODO: could I just use immutable here?
    public set(key: string | number, value: GraphNode | SerializableValue, tx: TransactionInfo): GraphNode {
        if (this.newerVersion) {
            // Always set on the newest version
            return this.newerVersion.set(key, value, tx);
        }
        if (tx.isOptimistic && this.newerOptimsticVersion) {
            return this.newerOptimsticVersion.set(key, value, tx);
        }
        // TODO: if value is an array, treat it differently.
        if (this.data[key] === value) {
            return this;
        }
        if (this.transactionId === tx.id) {
            // During a transaction, we only copy the node for the first change.
            // i.e. graph nodes are mutable for the duration of a transaction
            this.data[key] = value;
            return this;
        }
        const newNode = new GraphNode(tx, { ...this.data, [key]: value });
        newNode.adoptParents(this, tx);
        this.notifySubscribers(tx);
        if (tx.isOptimistic) {
            this.newerOptimsticVersion = newNode;
        } else {
            this.newerVersion = newNode;
        }
        return newNode;
    }

    public get(key: string | number): GraphNode | SerializableValue | undefined {
        return this.data[key];
    }
    public getProxy(selectionSet: SelectionSetNode, info: ReadInfo) {
        return new Proxy(this.data, new ObjectHandler(selectionSet, info));
    }

    public addParent(node: GraphNode, key: string | number) {
        this.parents.push({ node, key });
    }

    public setIndexEntry(index: NodeIndex, optimisticIndex: NodeIndex, key: string) {
        this.indexEntry = { index, optimisticIndex, key };
    }

    private notifySubscribers(tx: TransactionInfo) {
        // optimistic subscribers are interested in every update. non-optimistic subscribers
        // are only interested in non-optimistic updates
        tx.subscribersToNotify = tx.subscribersToNotify.concat(this.optimisticSubscribers);
        if (!tx.isOptimistic) {
            tx.subscribersToNotify = tx.subscribersToNotify.concat(this.subscribers);
        }
    }
}

export class ArrayGraphNode extends GraphNode {
    public getProxy(selectionSet: SelectionSetNode, info: ReadInfo) {
        // TODO: this is a hack
        const arr = Object.keys(this.data).map(node => this.data[node]);
        return new Proxy(arr, new ArrayHandler(selectionSet, info));
    }
}

export default class Store {
    public nodeIndex: NodeIndex; // TODO: make this private!
    public optimisticNodeIndex: NodeIndex;
    private lastTransactionId = 0;
    private activeSubscribers: Map<Subscriber, { query: DocumentNode, context?: ReadContext }> = new Map();
    constructor() {
        // TODO: add options like: schema, storeResolvers, etc.
        this.nodeIndex = Object.create(null);
        this.optimisticNodeIndex = Object.create(null);
    }


    public readQuery(query: DocumentNode, variables?: object) {
        return { data: this.read(query, { variables: variables as SerializableObject }) };
    }
    public writeQuery(query: DocumentNode, data: any, variables?: object) {
        return this.write(query, data.data, { variables: variables as SerializableObject });
    }

    // TODO: Figure out how to type the return value here
    // TODO: Make a version that doesn't use proxies but copies the object instead?
    // Read just reads once, returns an immutable result.
    // Challenge: if two queries read the exact same node/subtree out of the graph,
    // those subtrees should be referentially equal.
    // -> maybe by keeping the selection set on the node and comparing it could work. If it's
    // the same, return the same proxy. Equality is only guaranteed for named fragments
    // initially, but later we might extend it to any way you write the query.
    public read(query: DocumentNode, context?: ReadContext): SerializableObject | undefined {
        const readInfo = this.getReadInfo(query, context);
        if (!readInfo.rootNode) {
            return undefined; // Or should we throw an error here?
        }
        return readInfo.rootNode.getProxy(getOperationDefinitionOrThrow(query).selectionSet, readInfo);
    }

    public observe(query: DocumentNode, context?: ReadContext): Observable {
        return {
            subscribe: (subscriber: Subscriber) => {
                const readInfo = this.getReadInfo(query, context);
                if (typeof readInfo.rootNode === 'undefined') {
                    throw new Error(`Cannot subscribe to non-existent node with id ${readInfo.rootId}`);
                }

                readInfo.rootNode.subscribe(subscriber);
                // 1. Add subscriber to list of subscribers for rootId graph node
                // 2. Whenever rootId is changed, check if any of the observed fields have changed
                // 3. If rootId is deleted, call error on observable

                this.activeSubscribers.set(subscriber, { query, context });
                setTimeout(() => {
                    const data = this.read(query, context);
                    if (data) {
                        subscriber.next(data);
                    } else {
                        if (subscriber.error) { subscriber.error(new Error('No data returned for query')); }
                    }
                }, 0);

                // On unsubscribe, remove subscriber from list of subscribers for that graph node.
                const rn = readInfo.rootNode;
                return () => {
                    this.activeSubscribers.delete(subscriber);
                    rn.unsubscribe(subscriber);
                };
            },
        };
    }

    // TODO: Return a boolean that indicates whether anything in the store has changed.
    public write(query: DocumentNode, data: SerializableObject, context?: WriteContext): boolean {
        const txInfo: TransactionInfo = {
            id: this.lastTransactionId++,
            subscribersToNotify: [],
            isOptimistic: context && context.isOptimistic || false,
        };
        const rootSelectionSet = getOperationDefinitionOrThrow(query).selectionSet;
        const fragmentDefinitionMap = getFragmentDefinitionMap(query);
        // Call writeSelectionSet
        //   - recursively call writeSelectionSet on the result fields, starting at rootId.
        //   - for scalars: write each field in selection set iff it has changed.
        //     - for JSON scalars, do a deepEquals to be sure.
        //   - keep track if you've updated any fields. If you have, you must create a new
        //     object and pass it to the parent. To do this, keep a Map on the operation with
        //     parent -> [children, to, update].
        //   - When all data is written, go through the map of parents to update, and udpate
        //     its children there, creating a new parent and adding an entry to the parent update map.
        //   - While updating parents, keep a list of nodes that were already updated in this operation.
        //     due to cycles it's possible that a node may need to be updated twice. In that case,
        //     the node should not be copied, but instead the object should be updated in place, and no
        //     new entry should be added to the parent map.
        //   - Any subscribers encountered in the update operation should be added to the set of
        //     subscribers to notify. At the very end of the update, we schedule subscribers for notification
        //     on the next tick.
        //   - PROBLEM: Just because a node is updated doesn't mean that the change affects this
        //     subscriber. This is especially true of the root node. But let's solve this problem some other
        //     day.
        const rootId = context && context.rootId || QUERY_ROOT_ID;
        const rootNode: GraphNode | undefined = this.nodeIndex[rootId];

        const writeInfo: WriteInfo = {
            variables: context && context.variables || {},
            context: context && context.context || undefined,
            isOptimistic: context && context.isOptimistic || false,
            fragmentDefinitions: fragmentDefinitionMap,
            query,
            rootId,
            txInfo,
        };

        // TODO: Refactor to make nodeIndex a class. That way we can just call "set" here and provide
        // the write context to decide whether it should get the optimistic one or the normal one.
        const newRootNode = this.writeSelectionSet(rootNode, rootSelectionSet, data, writeInfo);
        if (newRootNode === rootNode) {
            return false; // This write changed nothing in the store, so we're done.
        }

        if (writeInfo.isOptimistic) {
            this.optimisticNodeIndex[rootId] = newRootNode;
        } else {
            this.nodeIndex[rootId] = newRootNode;
        }

        if (txInfo.subscribersToNotify.length) {
            txInfo.subscribersToNotify.forEach(s => {
                setTimeout(() => {
                    const {
                        query: subscriberQuery,
                        context: subscriberContext,
                    } = this.activeSubscribers.get(s);
                    if (subscriberQuery) {
                        const result = this.read(subscriberQuery, subscriberContext);
                        if (result) {
                            s.next(result);
                        } else {
                            if (s.error) { s.error(new Error('Subscription error: node was removed')); }
                        }
                    }
                }, 0);
            });
        }

        return true;
    }

    // transaction
    public tx(update: (store: Store) => void) {
        // TODO: should it be possible to do non-optimistic transactions? Might be useful for undo/redo.

        // Ideal optimistic transaction process:
        // 1. Enter transaction into Transaction Write-Ahead-Log
        // 2. Persist t-log changes to disk
        // 3. Apply optimistic transaction changes in memory
        //    - Read from current optimistic state
        //    - Write to current optimistic state
        // 4. Write transaction effects to disk in one go (need to collect nodes that have changed)
        // 5. Mark transaction as complete in t-log

        // Rolling back an optimistic transaction
        // 1. filter the transaction log to remove the transaction in question
        // 2. reapply all other transactions in the transaction log
        //  - Ideally run this as one transaction from the perspective of nodes so we can keep mutating
        // nodes instead of having to copy them.
        // To do this, a transaction id needs to be assigned

        // Optimizations we might want to do later:
        // - Roll back only until a certain transaction, then apply everything after that again (if there
        // are any things to apply)
        // - Skip applying a transaction and just use the previous result if the input to the transaction
        // hasn't changed.
        // - Commute transactions that are commutable when reapplying optimstic updates.
        // - Partially apply an update, then do a read in the middle (that doesn't see any of the updates),
        // then resume updating. Ideally this means that our updates can be done in chunks and then applied
        // in an atomic fashion such that the actual application of the update takes just a few ms, the fewer
        // the better.

        // Transaction (update, options) => handle
        // - turns into [input node set],  [output node set], status, update, options
        // when reapplying transactions, it would be great to just be able to jump to the last transaction
        // and use that state immediately, without having to undo/redo anything to get to that point. Then
        // from that point we could redo transactions, skipping those where the input set hasn't changed.
        // So basically, we'd want to store snapshots. It's not clear to me if we'd really gain anything from
        // that though... Maybe something to figure out later.

        // Problem: It is possible to have multiple disjoint roots in the store. If that wasn't possible and
        // we could know the exact entry points, then only the known root nodes would have to be preserved
        // as input and output nodes. All other nodes would automatically be linked to those. Actually, that might
        // not be true either because of the nodes in the index.

        update(this);
        // throw new Error('TODO: store transaction');
        return {
            commit() {
                // TODO
            },
            rollback() {
                // TODO
            },
        };
    }

    private getReadInfo(query: DocumentNode, context?: ReadContext): ReadInfo {
        const rootId = context && context.rootId || QUERY_ROOT_ID;
        const variables = context && context.variables || Object.create(null);
        const isOptimistic = context && context.isOptimistic || false;
        const fragmentDefinitions = getFragmentDefinitionMap(query);
        let rootNode = this.nodeIndex[rootId];
        if (isOptimistic && this.optimisticNodeIndex[rootId]) {
            // TODO: encapsulate this logic in the index.
            rootNode = this.optimisticNodeIndex[rootId];
        }
        return {
            query,
            variables,
            context,
            isOptimistic,
            rootId,
            rootNode,
            fragmentDefinitions,
        };
    }

    private writeSelectionSet(
        node: GraphNode | undefined,
        selectionSet: SelectionSetNode,
        data: SerializableObject,
        info: WriteInfo,
    ): GraphNode {
        // TODO: Update / set index if node with key has been written.
        let newNode = node || this.getExistingGraphNode(data) || new GraphNode(info.txInfo);
        selectionSet.selections.forEach(selection => {
            if (selection.kind === 'Field') {
                const dataName: string = (selection.alias && selection.alias.value) || selection.name.value;
                if (typeof data[dataName] === 'undefined') {
                    throw new Error(`Missing field ${dataName} in data for ${print(info.query)}`);
                }
                newNode = this.writeField(newNode, selection, data[dataName], info);
            } else {
                let fragment: InlineFragmentNode | FragmentDefinitionNode;
                if (selection.kind === 'InlineFragment') {
                    fragment = selection;
                } else {
                    fragment = info.fragmentDefinitions[selection.name.value];
                    if (!fragment) {
                        throw new Error(`No fragment named ${selection.name.value} in query print(${info.query})`);
                    }
                }
                if (isMatchingFragment(fragment, data)) {
                    newNode = this.writeSelectionSet(newNode, fragment.selectionSet, data, info);
                }
            }
        });
        const indexKey = getStoreKeyFromObject(data);
        if (indexKey) {
            newNode.setIndexEntry(this.nodeIndex, this.optimisticNodeIndex, indexKey);
            if (info.isOptimistic) {
                this.optimisticNodeIndex[indexKey] = newNode;
            } else {
                this.nodeIndex[indexKey] = newNode;
            }
        }
        return newNode;
    }

    private getExistingGraphNode(data: SerializableObject): GraphNode | undefined {
        const key = getStoreKeyFromObject(data);
        return key ? this.nodeIndex[key] : undefined;
    }

    private writeArrayNode(
        node: GraphNode | ArrayGraphNode,
        storeName: string | number,
        field: FieldNode,
        data: SerializableObject[],
        info: WriteInfo,
    ): GraphNode {
        const existingArrayNode = node.get(storeName);
        let arrayNode: ArrayGraphNode;
        if (existingArrayNode instanceof ArrayGraphNode) {
            arrayNode = existingArrayNode;
        } else {
            arrayNode = new ArrayGraphNode(info.txInfo);
        }
        // Create a child node for each element in the array.
        data.forEach((arrayElement, i) => {
            if (Array.isArray(arrayElement)) {
                // recurse for nested arrays
                arrayNode = this.writeArrayNode(arrayNode, i, field, arrayElement, info);
            } else {
                const currentElement = arrayNode.get(i);
                const childNode = this.writeSelectionSet(
                    currentElement instanceof GraphNode ? currentElement : undefined,
                    field.selectionSet as SelectionSetNode,
                    arrayElement,
                    info,
                );
                arrayNode = arrayNode.set(i, childNode, info.txInfo);
                childNode.addParent(arrayNode, i);
            }
        });
        // Set the field on the parent node.
        const parentNode = node.set(
            storeName,
            arrayNode,
            info.txInfo,
        );
        arrayNode.addParent(parentNode, storeName);
        return parentNode;
    }

    // TODO: Pass only what the field needs to know to the field. Hold back all other info.
    private writeField(
        node: GraphNode,
        field: FieldNode,
        data: SerializableValue,
        info: WriteInfo,
    ): GraphNode {
        const storeName: string = getStoreName(field, info.variables);
        if (field.selectionSet === null || typeof field.selectionSet === 'undefined' || data === null) {
            // Scalar (maybe array) field or null value
            return node.set(storeName, data, info.txInfo);
        } else {
            if (Array.isArray(data)) {
                return this.writeArrayNode(
                    node,
                    storeName,
                    field,
                    data,
                    info,
                );
                // If it's a nested array
                // Recurse in this function, create the child nodes when it's not an array
                // any more. Set parent on all the great* grandchildren.
            } else {
                const currentChild = node.get(storeName);
                const childNode = this.writeSelectionSet(
                    currentChild instanceof GraphNode ? currentChild : undefined,
                    field.selectionSet,
                    data as SerializableObject,
                    info,
                );
                const parentNode = node.set(
                    storeName,
                    childNode,
                    info.txInfo,
                );
                childNode.addParent(parentNode, storeName);
                return parentNode;
            }
        }
    }

    // private getHandler(query: SelectionSetNode, context: ReadContext): ProxyHandler {
    //     // TODO: make this more efficient later
    //     return { get(obj: GraphNode, name: string) { return obj[name] } };
    // }
}

function getOperationDefinitionOrThrow(query: DocumentNode): OperationDefinitionNode {
    let ret: OperationDefinitionNode | undefined;
    query.definitions.forEach(def => {
        if (def.kind === 'OperationDefinition') {
            ret = def;
            return;
        }
    });
    if (!ret) {
        throw new Error(`No operation definition found in query ${print(query)}`);
    }
    return ret;
}

function getFragmentDefinitionMap(query: DocumentNode): FragmentMap {
    let ret: { [key: string]: FragmentDefinitionNode } = Object.create(null);
    query.definitions.forEach(def => {
        if (def.kind === 'FragmentDefinition') {
            ret[def.name.value] = def;
        }
    });
    return ret;
}

function isMatchingFragment(fragment: InlineFragmentNode | FragmentDefinitionNode, data: SerializableObject) {
    if (!fragment.typeCondition) {
        // No type condition means fragment always matches
        return true;
    }
    // TODO: match on union and interface types
    return data.__typename === fragment.typeCondition.name.value;
}

function getStoreName(node: FieldNode, variables: SerializableObject): string {
    if (node.arguments && node.arguments.length) {
        // TODO this is slow, break it out to speed things up.
        const getArgString = (arg: ArgumentNode) => {
            if (arg.value.kind === 'Variable') {
                // TODO: serialize variables correctly
                return `${arg.name.value}: ${JSON.stringify(variables[arg.value.name.value])}`;
            } else if (arg.value.kind === 'NullValue') {
                return `${arg.name.value}: null`;
            } else if (arg.value.kind === 'ListValue') {
                throw new Error('List argument serialization not implemented');
                // return '';
            } else if (arg.value.kind === 'ObjectValue') {
                throw new Error('Object argument serialization not implemented');
                // return '';
            } else if (arg.value.kind === 'StringValue') {
                return `${arg.name.value}: "${arg.value.value}"`;
            }
            return `${arg.name.value}: ${arg.value.value}`;
        };
        return `${node.name.value}(${node.arguments.map(getArgString)})`;
    }
    return node.name.value;
}

function getStoreKeyFromObject(obj: SerializableObject): string | undefined {
    if (obj.__id) {
        return obj.__id as string | undefined;
    } else if (obj.__typename && obj.id) {
        return `${obj.__typename}:${obj.id}`;
    }
    return undefined;
}

function getFieldNodeFromSelectionSet(
    selectionSet: SelectionSetNode,
    fieldName: string,
    data: SerializableObject,
    info: ReadInfo,
): FieldNode | undefined {
    let matchingNode: FieldNode | undefined = undefined;
    selectionSet.selections.find((node: SelectionNode) => {
        if (node.kind === 'Field') {
            if (node.alias && node.alias.value === fieldName) {
                matchingNode = node;
                return true;
            }
            if (node.name && node.name.value === fieldName) {
                matchingNode = node;
                return true;
            }
        } else {
            let fragment: InlineFragmentNode | FragmentDefinitionNode;
            if (node.kind === 'InlineFragment') {
                fragment = node;
            } else if (node.kind === 'FragmentSpread') {
                fragment = info.fragmentDefinitions[node.name.value];
            } else {
                throw new Error(`Unrecognized node kind ${(node as FieldNode).kind}`);
            }
            if (isMatchingFragment(fragment, data)) {
                matchingNode = getFieldNodeFromSelectionSet(fragment.selectionSet, fieldName, data, info);
                return !!matchingNode;
            }
        }
        return false;
    });
    return matchingNode;
}

export class ArrayHandler {
    public constructor(private selectionSet: SelectionSetNode, private info: ReadInfo) {
    }

    public get(target: Array<GraphNode>, name: number) {
        // For length, non-existent properties etc. we just do a passthrough
        if (typeof target[name] !== 'object') {
            return target[name];
        }
        // TODO: Through the iterator it seems to be possible to directly access the underlying graphNode
        return target[name].getProxy(this.selectionSet, this.info);
    }
    public set() { return false; }
}

export class ObjectHandler {
    public constructor(
        private selectionSet: SelectionSetNode,
        private info: ReadInfo,
    ) {
    }

    public get(target: GraphNodeData, name: string): any {
        const node = getFieldNodeFromSelectionSet(this.selectionSet, name, target, this.info);
        if (node) {
            const storeName = getStoreName(node, this.info.variables);
            const value = target[storeName];
            if (typeof value === 'undefined') {
                console.error('unexpected undefined value at ', storeName);
            } else if (value === null) {
                return null;
            } else if (node.selectionSet) {
                if (value instanceof ArrayGraphNode) {
                    // return new Proxy(target[storeName], this.getArrayHandler(node.selectionSet.selections, variables));
                    return (value as ArrayGraphNode).getProxy(node.selectionSet, this.info);
                }
                return (value as GraphNode).getProxy(node.selectionSet, this.info);
            }
            // It's a scalar
            return value;
        } else {
            // This happens for a whole bunch of Symbol accesses etc.
            return undefined;
        }
    }

    public ownKeys(target: GraphNodeData): string[] {
        // TODO: check this more carefully, and make it work with fragments.
        return this.getFieldsInSelectionSet(this.selectionSet, target);
    }

    public getOwnPropertyDescriptor(target: GraphNodeData, prop: string) {
        const val = this.get(target, prop);
        if (typeof val === 'undefined') {
            return undefined;
        }
        // TODO: why is this value not just val? There was a reason, but I don't remember now.
        return { enumerable: true, configurable: true, value: this.get(target, prop) };
    }

    public set() { return false; }
    public preventExtensions() { return false; }
    public isExtensible() { return false; }
    public deleteProperty() { return false; }
    public defineProperty() { return false; }

    private getFieldsInSelectionSet(selectionSet: SelectionSetNode, data: GraphNodeData): string[] {
        let keys: string[] = [];
        selectionSet.selections.forEach((node: SelectionNode) => {
            if (node.kind === 'Field') {
                if (node.alias) {
                    keys.push(node.alias.value);
                } else {
                    keys.push(node.name.value);
                }
            } else if (node.kind === 'InlineFragment') {
                if (isMatchingFragment(node, data)) {
                    keys = keys.concat(this.getFieldsInSelectionSet(node.selectionSet, data));
                }
            } else if (node.kind === 'FragmentSpread') {
                const fragment = this.info.fragmentDefinitions[node.name.value];
                if (!fragment) {
                    throw new Error(`Named fragment ${node.name.value} missing in query ${this.info.query}`);
                }
                if (isMatchingFragment(fragment, data)) {
                    keys = keys.concat(this.getFieldsInSelectionSet(fragment.selectionSet, data));
                }
            } else {
                throw new Error(`Encountered node of unknown kind: ${(node as FieldNode).kind}`);
            }
        });
        return keys;
    }
}
