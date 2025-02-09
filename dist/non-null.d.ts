import { GraphQLError } from "graphql";
import { CompilationContext } from "./execution";
export declare type NullTrimmer = (data: any, errors: GraphQLError[]) => any;
/**
 *
 * @param {CompilationContext} compilationContext
 * @returns {(data: any, errors: GraphQLError[]) => {data: any; errors: GraphQLError[]}}
 */
export declare function createNullTrimmer(compilationContext: CompilationContext): NullTrimmer;
