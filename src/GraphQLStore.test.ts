import gql from 'graphql-tag';
import GraphQLStore, {
    SerializableObject,
} from './GraphQLStore';
import {
    DocumentNode,
} from 'graphql';

const state = {
    nodes: {
        'Stack:5': {
            id: '5',
            __typename: 'Stack',
            name: 'Stack 5',
            zettelis: [] as any[],
        },
        'Zetteli:2': {
            id: '2',
            __typename: 'Zetteli',
            tags: ['t1', 't2'],
            body: 'Z2',
        },
        'Zetteli:3': {
            id: '3',
            __typename: 'Zetteli',
            tags: ['t2', 't3'],
            body: 'Z3',
        },
    },
    data: {
        'allStacks': undefined as any,
        'stack(id: 5)': undefined as any,
    },
};

state.nodes['Stack:5']['zettelis'] = [state.nodes['Zetteli:2'], state.nodes['Zetteli:3']];
state.data['stack(id: 5)'] = state.nodes['Stack:5'];
state.data['allStacks'] = [state.nodes['Stack:5']];

const store = new GraphQLStore();
const bootstrapQuery = gql`
 {
     allStacks {
         id
         __typename
         name
         zettelis(last: 2) {
             id
             __typename
             tags
             body
         }
     }
     stack(id: 5) {
         id
         __typename
         name
         zettelis(last: 2) {
             id
             __typename
             tags
             body
         }
     }
 }
 `;
const bootstrapData = {
    allStacks: state.data['allStacks'],
    stack: state.data['stack(id: 5)'],
};
store.write(bootstrapQuery, bootstrapData);

describe('proxy store', () => {
    describe('reading', () => {
        let simpleQuery = gql`
        query {
            allStacks {
                id
                name
            }
        }
        `;
        let simpleResponse = {
            data: {
                allStacks: [{
                    id: '5',
                    name: 'Stack 5',
                }],
            },
        };

        it('doesn\'t throw', () => {
            expect(() => store.readQuery(simpleQuery)).not.toThrow();
        });

        describe('simple query', () => {
            const query = simpleQuery;
            let result: any;
            const expectedResponse = simpleResponse;

            beforeEach(() => {
                result = store.readQuery(query);
            });

            it('can read a simple query from the store', () => {
                expect(result).toEqual(expectedResponse);
            });
            it('only lets you iterate over keys you asked for', () => {
                expect(Object.keys(result)).toEqual(Object.keys(expectedResponse));
                expect(Object.keys(result.data)).toEqual(Object.keys(expectedResponse.data));
                expect(Object.keys(result.data.allStacks)).toEqual(Object.keys(expectedResponse.data.allStacks));
                expect(Object.keys(result.data.allStacks[0])).toEqual(Object.keys(expectedResponse.data.allStacks[0]));
            });
            it('only lets you read properties you asked for', () => {
                expect(result.data.allStacks[0].name).toBeDefined();
                const simpleQuery2 = gql`
                query {
                    allStacks {
                        id
                    }
                }
                `;
                const result2 = store.readQuery(simpleQuery2);
                expect(result2.data.allStacks[0].name).toBeUndefined();
            });
            it('does not allow you to modify object properties', () => {
                expect(() => result.data.allStacks[0].name = 'NEW').toThrow();
            });
            it('does not allow you to modify array elements', () => {
                expect(() => result.data.allStacks[0] = {}).toThrow();
            });
            it('does not allow you to delete object properties', () => {
                expect(() => { delete result.data.allStacks[0].name; }).toThrow();
            });
            it('does not allow you to add new object properties', () => {
                expect(() => result.data.allStacks[0].name2 = 'NEW PROP').toThrow();
            });
        });

        describe('error handling', () => {
            it.skip('sets a flag when only partial data is available', () => {
                expect(false).toBe(true);
            });
        });

        describe('query with arguments', () => {
            it('can handle a query with inline arguments', () => {
                // Proxy has to do indirection here, look up the right field.
                const query = gql`
                query {
                    stack(id: 5) {
                        id
                        name
                    }
                }
                `;
                const result = store.readQuery(query);
                const argResponse = {
                    data: {
                        stack: {
                            id: '5',
                            name: 'Stack 5',
                        },
                    },
                };
                expect(result).toEqual(argResponse);
            });
            it('can handle a query with variables', () => {
                // TODO
                const query = gql`
                query ($stackId: Int) {
                    stack(id: $stackId) {
                        id
                        name
                    }
                }
                `;
                const variables = { stackId: 5 };
                const result = store.readQuery(query, variables);
                const argResponse = {
                    data: {
                        stack: {
                            id: '5',
                            name: 'Stack 5',
                        },
                    },
                };
                expect(result).toEqual(argResponse);
                // Proxy has to do indirection here, look up the right field.
            });
        });


        describe('query with aliases', () => {
            it('can handle a query with aliases', () => {
                const aliasQuery = gql`
                query {
                    myStacks: allStacks {
                        id
                        __typename
                        aName: name
                    }
                }
                `;
                const expectedResponse = {
                    data: {
                        myStacks: [{
                            id: '5',
                            __typename: 'Stack',
                            aName: 'Stack 5',
                        }],
                    },
                };
                expect(store.readQuery(aliasQuery)).toEqual(expectedResponse);
            });
        });

        it('query with inline fragment without type condition', () => {
            let simpleFragmentQuery = gql`
            query {
                allStacks {
                    ... {
                        id
                        name
                    }
                }
            }
            `;
            expect(store.readQuery(simpleFragmentQuery)).toEqual(simpleResponse);
        });

        it('query with inline fragment with matching type condition', () => {
            let simpleFragmentQuery = gql`
            query {
                allStacks {
                    ... on Stack {
                        id
                        name
                    }
                }
            }
            `;
            expect(store.readQuery(simpleFragmentQuery)).toEqual(simpleResponse);
        });

        it('query with nested fragments', () => {
            let simpleFragmentQuery = gql`
            query {
                allStacks {
                    ... on Stack {
                        id
                        ... {
                            name
                        }
                    }
                }
            }
            `;
            expect(store.readQuery(simpleFragmentQuery)).toEqual(simpleResponse);
        });

        it('query with inline fragment with non-matching type condition', () => {
            let simpleFragmentQuery = gql`
            query {
                allStacks {
                    ... {
                        id
                        name
                    }
                    ... on ReallyNotAStack {
                        __typename
                    }
                }
            }
            `;
            expect(store.readQuery(simpleFragmentQuery)).toEqual(simpleResponse);
        });

        it('query with a simple named fragment', () => {
            let simpleNamedFragmentQuery = gql`
            query {
                allStacks {
                    ... F1
                }
            }

            fragment F1 on Stack {
                id
                name
            }
            `;
            expect(store.readQuery(simpleNamedFragmentQuery)).toEqual(simpleResponse);
        });

        it.skip('query with inline fragment on interface or union type', () => {
            // TODO
        });

        it.skip('query with named fragments on interface or union type', () => {
            // TODO
        });

        describe('nested arrays', () => {
            it('can write + read an array nested 6 levels deep', () => {
                const data = {
                    authorNested: [[[[[[{ id: '5', __typename: 'Author', name: 'Tony Judt' }]]]]]],
                };
                const query = gql`{
                    authorNested {
                        id
                        __typename
                        name
                    }
                }`;
                store.write(query, data);
                expect(store.read(query)).toEqual(data);
            });
        });
    });

    describe('writing', () => {
        it('Can write a simple query without arguments and read it back', () => {
            const query = gql`
              query {
                someRandomKey { id }
              }
            `;
            const value = {
                data: {
                    someRandomKey: {
                        id: 19,
                    },
                },
            };
            store.writeQuery(query, value);
            expect(store.readQuery(query)).toEqual(value);
        });
        it('Can write a query containing inline arguments', () => {
            const query = gql`
            query {
              someRandomKey(key: "ABC") { id }
            }
          `;
            const value = {
                data: {
                    someRandomKey: {
                        id: 999,
                    },
                },
            };
            store.writeQuery(query, value);
            expect(store.readQuery(query)).toEqual(value);
        });
        it('writes to the same field with different arguments don\'t affect each other', () => {
            const query = gql`
            query A($key: String){
              someRandomKey(key: $key) { id }
            }
          `;
            const value = {
                data: {
                    someRandomKey: {
                        id: 111,
                    },
                },
            };
            const variables = { key: 'X' };
            const value2 = {
                data: {
                    someRandomKey: {
                        id: 222,
                    },
                },
            };
            const variables2 = { key: 'Y' };
            store.writeQuery(query, value, variables);
            store.writeQuery(query, value2, variables2);
            expect(store.readQuery(query, variables)).toEqual(value);
            expect(store.readQuery(query, variables2)).toEqual(value2);
        });
        // TODO: test the following inline and variable arguments:
        // - null
        // - object (including nested)
        // - enum
        // - array
        // and make sure that stuff written with variables can be read
        // with inline arguments and vice versa
        it('Can write a query containing variables', () => {
            const query = gql`
            query A($key: Boolean, $str: String) {
              someRandomKey(key: $key, str: $str) { id }
            }
            `;
            const value = {
                data: {
                    someRandomKey: {
                        id: 888,
                    },
                },
            };
            const variables = { key: true, str: 'A' };
            store.writeQuery(query, value, variables);
            // console.log(JSON.stringify(store, null, 2));
            expect(store.readQuery(query, variables)).toEqual(value);
        });
        it('Can write arrays', () => {
            const query = gql`
            query {
              someArray { id value }
            }
          `;
            const value = {
                data: {
                    someArray: [
                        {
                            id: 19,
                            value: 'val',
                        },
                        {
                            id: 20,
                            value: 'val2',
                        },
                    ],
                },
            };
            store.writeQuery(query, value);
            expect(store.readQuery(query)).toEqual(value);
        });
        // Skipping because when I print the store this makes the output hard to read
        it('Can write an array with 10K indexed nodes in under 100ms', () => {
            // TODO: 100 ms is way too much.
            // TODO: shouldn't use more than 5ms on the main thread if busy, 50ms if idle.

            // Goals:
            //  - stay under 5ms for sync time on UI thread. (maybe 50ms is good enough for actions?)
            //  - stay under 50ms for applying an update and notifying all subscribers
            //  - stay under 500ms for reading from disk
            const N = 10 ** 4;
            const longArray: any[] = [];
            for (let i = 0; i < N; i++) {
                longArray[i] = {
                    id: i,
                    value: `Value ${i}`,
                    __typename: 'Boo',
                };
            }
            const query = gql`
            query {
              longArray { __typename id value }
            }
          `;
            const value = {
                data: {
                    longArray: longArray,
                },
            };
            const start = process.hrtime()[1];
            store.writeQuery(query, value);
            const x = store.readQuery(query).data.longArray;
            const duration = (process.hrtime()[1] - start);
            // console.log('10K normalized array plain ms', duration / 1000000);
            expect(duration / 1000000).toBeLessThan(100); // The goal here should be 50!
            // expect(x.length).toBe(N);
        });

        it('Can write + read an array with 10M numbers in a flash', () => {
            // This test basically just verifies that we don't go over each element
            // in a scalar array. So this operation should be very fast.
            const N = 10 ** 7;
            const longArray: any[] = [];
            for (let i = 0; i < N; i++) {
                longArray[i] = i;
            }
            const query = gql`
            query {
              longScalarArray
            }
          `;
            const value = {
                data: {
                    longScalarArray: longArray,
                },
            };
            const start = process.hrtime()[1];
            store.writeQuery(query, value);
            const x = store.readQuery(query).data.longScalarArray as number[];
            const duration = (process.hrtime()[1] - start);
            // console.log('10M array plain ms', duration / 1000000);
            expect(duration / 1000000).toBeLessThan(1);
            expect(x.length).toBe(N);
        });

        it('Can write and read a nested array with 10K x 10K numbers in a flash', () => {
            // Should be almost instantaneous, just needs to copy a pointer
            const N = 10 ** 4;
            const M = 10 ** 4;
            const nestedArray: any[] = [];
            for (let i = 0; i < N; i++) {
                let innerArray: any[] = [];
                for (let j = 0; j < M; j++) {
                    innerArray[j] = i * M + j;
                }
                nestedArray[i] = innerArray;
            }
            const query = gql`
            query {
                nestedArray
            }
            `;
            const value = {
                data: {
                    nestedArray,
                },
            };
            const start = process.hrtime()[1];
            store.writeQuery(query, value);
            const x = store.readQuery(query).data.nestedArray as number[][];
            const duration = (process.hrtime()[1] - start);
            // console.log('10K x 10K array plain ms', duration / 1000000);
            expect(duration / 1000000).toBeLessThan(1);
            expect(x.length).toBe(N);
            expect(x[N - 1].length).toBe(M);
            expect(x[N - 1][M - 1]).toBe(N * M - 1);
        });

        it('Can write null values', () => {
            const query = gql`
            query {
              nullIdValue { id }
            }
            `;
            const value = {
                data: {
                    nullIdValue: {
                        id: null,
                    },
                },
            };
            store.writeQuery(query, value);
            expect(store.readQuery(query)).toEqual(value);
        });
        describe('fragments', () => {
            it('Can write a query containing an inline fragment without type condition', () => {
                const query = gql`
                query {
                  inlineFragmentObj {
                      ... {
                        id
                      }
                  }
                }
              `;
                const value = {
                    data: {
                        inlineFragmentObj: {
                            id: 999,
                        },
                    },
                };
                store.writeQuery(query, value);
                expect(store.readQuery(query)).toEqual(value);
            });
            it('Can write a query containing inline fragments with type condition', () => {
                const query = gql`
                query {
                  inlineFragmentObj2 {
                      ... on Horse {
                        __typename
                        id
                        numLegs
                      }
                      ... on Camel {
                          numBumps
                      }
                  }
                }
              `;
                const value = {
                    data: {
                        inlineFragmentObj2: {
                            __typename: 'Horse',
                            id: 999,
                            numLegs: 4,
                        },
                    },
                };
                store.writeQuery(query, value);
                expect(store.readQuery(query)).toEqual(value);
            });
        });
        it('Can write a query containing named fragments', () => {
            const query = gql`
            query {
              inlineFragmentObj2 {
                  ...HF
                  ...CF
              }
            }

            fragment HF on Horse {
                __typename
                id
                numLegs
            }
            fragment CF on Camel {
                numBumps
            }
          `;
            const value = {
                data: {
                    inlineFragmentObj2: {
                        __typename: 'Horse',
                        id: 999,
                        numLegs: 4,
                    },
                },
            };
            store.writeQuery(query, value);
            expect(store.readQuery(query)).toEqual(value);
        });
        it('Can write a query containing nested named fragments', () => {
            const query = gql`
            query {
              inlineFragmentObj2 {
                  ...HF2
                  ...CF2
              }
            }

            fragment HB on Horse {
                __typename
                id
            }
            fragment HF2 on Horse {
                ...HB
                numLegs
            }
            fragment CF2 on Camel {
                numBumps
            }
          `;
            const value = {
                data: {
                    inlineFragmentObj2: {
                        __typename: 'Horse',
                        id: 999,
                        numLegs: 4,
                    },
                },
            };
            store.writeQuery(query, value);
            expect(store.readQuery(query)).toEqual(value);
        });
        it('Can overwrite existing values', () => {
            const query = gql`
            query A($key: String){
              someRandomKey(key: $key) { id }
            }
            `;
            const value = {
                data: {
                    someRandomKey: {
                        id: 111,
                    },
                },
            };
            const variables = { key: 'X' };
            const value2 = {
                data: {
                    someRandomKey: {
                        id: 222,
                    },
                },
            };
            store.writeQuery(query, value, variables);
            expect(store.readQuery(query, variables)).toEqual(value);
            store.writeQuery(query, value2, variables);
            expect(store.readQuery(query, variables)).toEqual(value2);
        });
        it('Writes don\'t affect earlier reads', () => {
            const query = gql`
            query A($key: String){
              someRandomKey(key: $key) { id }
            }
            `;
            const value = {
                data: {
                    someRandomKey: {
                        id: 111,
                    },
                },
            };
            const variables = { key: 'X' };
            const value2 = {
                data: {
                    someRandomKey: {
                        id: 222,
                    },
                },
            };
            store.writeQuery(query, value, variables);
            const firstResult = store.readQuery(query, variables);
            store.writeQuery(query, value2, variables);
            expect(store.readQuery(query, variables)).toEqual(value2);
            // Read the result only after the second write succeeded.
            expect(firstResult).toEqual(value);
        });
        it('Merges new data with existing data in the store if it overlaps', () => {
            const query1 = gql`{
                mergeObj {
                    firstName
                }
            }`;
            const query2 = gql`{
                mergeObj {
                    lastName
                }
            }`;
            const fullQuery = gql`{
                mergeObj {
                    firstName
                    lastName
                }
            }`;
            const data1 = { data: { mergeObj: { firstName: 'Peter' } } };
            const data2 = { data: { mergeObj: { lastName: 'Pan' } } };
            const fullData = { data: { mergeObj: { firstName: 'Peter', lastName: 'Pan' } } };
            store.writeQuery(query1, data1);
            store.writeQuery(query2, data2);
            expect(store.readQuery(fullQuery)).toEqual(fullData);
        });
        it('normalizes objects with the same id', () => {
            const query = gql`
            query A{
              refA{ id __typename payload }
            }
            `;
            const value = {
                data: {
                    refA: {
                        id: 111,
                        __typename: 'OBJ',
                        payload: 'A',
                    },
                },
            };
            const query2 = gql`
            query A{
              refB{ id __typename payload }
            }
            `;
            const value2 = {
                data: {
                    refB: {
                        id: 111,
                        __typename: 'OBJ',
                        payload: 'B',
                    },
                },
            };
            store.writeQuery(query, value);
            store.writeQuery(query2, value2);
            expect(store.readQuery(query2)).toEqual(value2);
            expect((store.readQuery(query).data.refA as any).payload).toEqual('B');
        });
        it('Merges fields of objects with the same id across writes', () => {
            const query1 = gql`{
                alias1 {
                    __id
                    firstName
                }
            }`;
            const query2 = gql`{
                alias2 {
                    __id
                    lastName
                }
            }`;
            const fullQuery = gql`{
                alias1 {
                    firstName
                    lastName
                }
            }`;
            const data1 = { data: { alias1: { __id: 'test-128382', firstName: 'Peter' } } };
            const data2 = { data: { alias2: { __id: 'test-128382', lastName: 'Pan' } } };
            const fullData = { data: { alias1: { firstName: 'Peter', lastName: 'Pan' } } };
            store.writeQuery(query1, data1);
            store.writeQuery(query2, data2);
            expect(store.readQuery(fullQuery)).toEqual(fullData);
        });
        it('throws an error if a query field is missing in the data', () => {
            const query = gql`
            query MissingData {
              nullIdValue { id }
            }
            `;
            const value = {
                data: {
                    nullIdValue: {
                        // id: null, // missing data!
                    },
                },
            };
            expect(() => store.writeQuery(query, value)).toThrow(/Missing field id/);
        });
        it.skip('thows an error if a variable value marked as required is missing', () => {
            expect(false).toBe(true);
        });
    });
    describe('observers', () => {
        it('Can observe a simple query and get the current result', () => {
            const query = gql`
            {
                obs {
                    name
                }
            }`;
            const data = {
                obs: { name: 'Watch this.' },
            };
            const data2 = {
                obs: { name: 'Now see me change' },
            };
            store.write(query, data);
            store.observe(query).subscribe({
                next: (result) => {
                    // TODO
                    // console.log('result', result);
                },
                error: (e) => {
                    console.error(e);
                },
            });
            setTimeout(() => store.write(query, data2), 10);
            return new Promise(resolve => setTimeout(resolve, 100));
        });

    });
    describe('optimistic transactions', () => {
        let query: DocumentNode;
        let data: SerializableObject;
        let optimisticData: SerializableObject;
        beforeEach(() => {
            query = gql`
            {
                glass {
                    phrase
                    who
                }
            }`;
            data = {
                glass: {
                    phrase: 'Half Empty',
                    who: 'Pessimist',
                },
            };
            optimisticData = {
                glass: {
                    phrase: 'Half full',
                    who: 'Optimist',
                },
            };
            store.write(query, data);
            store.write(query, optimisticData, { isOptimistic: true });
        });
        it('optimistic writes are ignored by non-optimistic readers', () => {
            expect(store.read(query)).toEqual(data);
        });
        it('optimistic writes can be read by optimistic readers', () => {
            expect(store.read(query, { isOptimistic: true })).toEqual(optimisticData);
        });
        // Affect optimstic observers
        // Don't affect non-optimistic observers

        // Can quickly apply 1000 optimistic updates, roll back the first one and reapply the 999 others.

        // Can stack two optimistic updates on top of each other

        // Can roll back optimistic updates.
    });
});
