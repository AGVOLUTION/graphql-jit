import { DocumentNode, ExecutionResult, GraphQLError, GraphQLFieldResolver, GraphQLIsTypeOfFn, GraphQLObjectType, GraphQLOutputType, GraphQLSchema } from "graphql";
import { ExecutionContext as GraphQLContext } from "graphql/execution/execute";
import { FieldNode } from "graphql/language/ast";
import { GraphQLTypeResolver } from "graphql/type/definition";
import { Arguments, ObjectPath } from "./ast";
import { GraphQLError as GraphqlJitError } from "./error";
import { NullTrimmer } from "./non-null";
import { ResolveInfoEnricherInput } from "./resolve-info";
import { Maybe } from "./types";
import { CoercedVariableValues } from "./variables";
declare const inspect: (value: any) => string;
export interface CompilerOptions {
    customJSONSerializer: boolean;
    disableLeafSerialization: boolean;
    disablingCapturingStackErrors: boolean;
    customSerializers: {
        [key: string]: (v: any) => any;
    };
    /**
     * If true, the generated code for variables compilation validates
     * that there are no circular references (at runtime). For most cases,
     * the variables are the result of JSON.parse and in these cases, we
     * do not need this. Enable this if the variables passed to the execute
     * function may contain circular references.
     *
     * When enabled, the code checks for circular references in the
     * variables input, and throws an error when found.
     *
     * Default: false
     */
    variablesCircularReferenceCheck: boolean;
    resolverInfoEnricher?: (inp: ResolveInfoEnricherInput) => object;
}
/**
 * The context used during compilation.
 *
 * It stores deferred nodes to be processed later as well as the function arguments to be bounded at top level
 */
export interface CompilationContext extends GraphQLContext {
    resolvers: {
        [key: string]: GraphQLFieldResolver<any, any, any>;
    };
    serializers: {
        [key: string]: (c: ExecutionContext, v: any, onError: (c: ExecutionContext, msg: string) => void) => any;
    };
    hoistedFunctions: string[];
    hoistedFunctionNames: Map<string, number>;
    typeResolvers: {
        [key: string]: GraphQLTypeResolver<any, any>;
    };
    isTypeOfs: {
        [key: string]: GraphQLIsTypeOfFn<any, any>;
    };
    resolveInfos: {
        [key: string]: any;
    };
    deferred: DeferredField[];
    options: CompilerOptions;
    depth: number;
}
export declare const GLOBAL_VARIABLES_NAME = "__context.variables";
interface ExecutionContext {
    promiseCounter: number;
    data: any;
    errors: GraphQLError[];
    nullErrors: GraphQLError[];
    resolve?: () => void;
    inspect: typeof inspect;
    variables: {
        [key: string]: any;
    };
    context: any;
    rootValue: any;
    safeMap: typeof safeMap;
    GraphQLError: typeof GraphqlJitError;
    resolvers: {
        [key: string]: GraphQLFieldResolver<any, any, any>;
    };
    trimmer: NullTrimmer;
    serializers: {
        [key: string]: (c: ExecutionContext, v: any, onError: (c: ExecutionContext, msg: string) => void) => any;
    };
    typeResolvers: {
        [key: string]: GraphQLTypeResolver<any, any>;
    };
    isTypeOfs: {
        [key: string]: GraphQLIsTypeOfFn<any, any>;
    };
    resolveInfos: {
        [key: string]: any;
    };
}
interface DeferredField {
    name: string;
    responsePath: ObjectPath;
    originPaths: string[];
    destinationPaths: string[];
    parentType: GraphQLObjectType;
    fieldName: string;
    jsFieldName: string;
    fieldType: GraphQLOutputType;
    fieldNodes: FieldNode[];
    args: Arguments;
}
export interface CompiledQuery {
    operationName?: string;
    query: (root: any, context: any, variables: Maybe<{
        [key: string]: any;
    }>) => Promise<ExecutionResult> | ExecutionResult;
    stringify: (v: any) => string;
}
/**
 * It compiles a GraphQL query to an executable function
 * @param {GraphQLSchema} schema GraphQL schema
 * @param {DocumentNode} document Query being submitted
 * @param {string} operationName name of the operation
 * @param partialOptions compilation options to tune the compiler features
 * @returns {CompiledQuery} the cacheable result
 */
export declare function compileQuery(schema: GraphQLSchema, document: DocumentNode, operationName?: string, partialOptions?: Partial<CompilerOptions>): CompiledQuery | ExecutionResult;
export declare function isCompiledQuery<C extends CompiledQuery, E extends ExecutionResult>(query: C | E): query is C;
export declare function createBoundQuery(compilationContext: CompilationContext, document: DocumentNode, func: (context: ExecutionContext) => Promise<any> | undefined, getVariableValues: (inputs: {
    [key: string]: any;
}) => CoercedVariableValues, operationName?: string): (rootValue: any, context: any, variables: Maybe<{
    [key: string]: any;
}>) => Promise<ExecutionResult> | ExecutionResult;
/**
 * Implements a generic map operation for any iterable.
 *
 * If the iterable is not valid, null is returned.
 * @param context
 * @param {Iterable<any> | string} iterable possible iterable
 * @param {(a: any) => any} cb callback that receives the item being iterated
 * @param idx
 * @returns {any[]} a new array with the result of the callback
 */
declare function safeMap(context: ExecutionContext, iterable: Iterable<any> | string, cb: (context: ExecutionContext, a: any, index: number, resultArray: any[], ...idx: number[]) => any, ...idx: number[]): any[];
export declare function isPromise(value: any): value is Promise<any>;
export declare function isPromiseInliner(value: string): string;
export {};
