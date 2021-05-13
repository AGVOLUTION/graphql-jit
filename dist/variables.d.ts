import { GraphQLError, GraphQLSchema, VariableDefinitionNode } from "graphql";
export declare type CoercedVariableValues = FailedVariableCoercion | VariableValues;
interface FailedVariableCoercion {
    errors: ReadonlyArray<GraphQLError>;
}
interface VariableValues {
    coerced: {
        [key: string]: any;
    };
}
export declare function failToParseVariables(x: any): x is FailedVariableCoercion;
export interface VariablesCompilerOptions {
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
     * Default: false (set in execution.ts)
     */
    variablesCircularReferenceCheck: boolean;
}
export declare function compileVariableParsing(schema: GraphQLSchema, options: VariablesCompilerOptions, varDefNodes: ReadonlyArray<VariableDefinitionNode>): (inputs: {
    [key: string]: any;
}) => CoercedVariableValues;
export {};
