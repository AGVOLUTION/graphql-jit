import { FieldNode, GraphQLObjectType, GraphQLOutputType, GraphQLResolveInfo } from "graphql";
export declare type GraphQLJitResolveInfo<Enrichments> = GraphQLResolveInfo & Enrichments;
export interface ResolveInfoEnricherInput {
    schema: GraphQLResolveInfo["schema"];
    fragments: GraphQLResolveInfo["fragments"];
    operation: GraphQLResolveInfo["operation"];
    parentType: GraphQLObjectType;
    returnType: GraphQLOutputType;
    fieldName: string;
    fieldNodes: FieldNode[];
}
export interface FieldExpansion {
    [returnType: string]: TypeExpansion;
}
export interface TypeExpansion {
    [fieldName: string]: FieldExpansion | LeafField;
}
declare const LeafFieldSymbol: unique symbol;
export interface LeafField {
    [LeafFieldSymbol]: true;
}
export declare function isLeafField(obj: LeafField | FieldExpansion): obj is LeafField;
/**
 * Compute the GraphQLJitResolveInfo's `fieldExpansion` and return a function
 * that returns the computed resolveInfo. This thunk is registered in
 * context.dependencies for the field's resolveInfoName
 */
export declare function createResolveInfoThunk<T>({ schema, fragments, operation, parentType, fieldName, fieldType, fieldNodes }: {
    schema: GraphQLResolveInfo["schema"];
    fragments: GraphQLResolveInfo["fragments"];
    operation: GraphQLResolveInfo["operation"];
    parentType: GraphQLObjectType;
    fieldType: GraphQLOutputType;
    fieldName: string;
    fieldNodes: FieldNode[];
}, enricher?: (inp: ResolveInfoEnricherInput) => T): any;
export declare function fieldExpansionEnricher(input: ResolveInfoEnricherInput): {
    fieldExpansion: FieldExpansion;
};
export {};
