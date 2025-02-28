"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNullTrimmer = void 0;
const graphql_1 = require("graphql");
const type_1 = require("graphql/type");
const lodash_merge_1 = __importDefault(require("lodash.merge"));
const ast_1 = require("./ast");
/**
 *
 * @param {CompilationContext} compilationContext
 * @returns {(data: any, errors: GraphQLError[]) => {data: any; errors: GraphQLError[]}}
 */
function createNullTrimmer(compilationContext) {
    return trimData(parseQueryNullables(compilationContext));
}
exports.createNullTrimmer = createNullTrimmer;
/**
 * Trims a data response according to the field erros in non null fields.
 *
 * Errors are filtered to ensure a single field error per field.
 *
 * @param {QueryMetadata} nullable Description of the query and their nullability
 * @returns {(data: any, errors: GraphQLError[]) => {data: any; errors: GraphQLError[]}}
 * the trimmed data and a filtered list of errors.
 */
function trimData(nullable) {
    return (data, errors) => {
        const finalErrors = [];
        const processedErrors = new Set();
        for (const error of errors) {
            if (!error.path) {
                // should never happen, it is a bug if it does
                throw new Error("no path available for tree trimming");
            }
            if (processedErrors.has(error.path.join("."))) {
                // there can be multiple field errors in some scenario
                // there is no need to continue processing and it should not be part of the final response
                continue;
            }
            const ancestors = findNullableAncestor(nullable, error.path);
            // The top level field is always nullable
            // http://facebook.github.io/graphql/June2018/#sec-Errors-and-Non-Nullability
            //
            // There is no mention if the following errors need to be present in the response.
            // For now we assume this is not needed.
            if (ancestors.length === 0) {
                data = null;
                finalErrors.push(error);
                break;
            }
            removeBranch(data, ancestors);
            processedErrors.add(error.path.join("."));
            finalErrors.push(error);
        }
        return { data, errors: finalErrors };
    };
}
/**
 * Removes a branch out of the response data by mutating the original object.
 *
 * @param tree response data
 * @param {Array<number | string>} branch array with the path that should be trimmed
 */
function removeBranch(tree, branch) {
    for (let i = 0; i < branch.length - 1; ++i) {
        tree = tree[branch[i]];
    }
    const toNull = branch[branch.length - 1];
    tree[toNull] = null;
}
/**
 * Name of the child used in array to contain the description.
 *
 * Only used for list to contain the child description.
 */
const ARRAY_CHILD_NAME = "index";
/**
 *
 * @param {QueryMetadata} nullable Description of the query and their nullability
 * @param {ReadonlyArray<string | number>} paths path of the error location
 * @returns {Array<string | number>} path of the branch to be made null
 */
function findNullableAncestor(nullable, paths) {
    let lastNullable = 0;
    for (let i = 0; i < paths.length; ++i) {
        const path = paths[i];
        const child = nullable.children[typeof path === "string" ? path : ARRAY_CHILD_NAME];
        if (!child) {
            // Stopping the search since we reached a leaf node,
            // the loop should be on its final iteration
            break;
        }
        if (child.isNullable) {
            lastNullable = i + 1;
        }
        nullable = child;
    }
    return paths.slice(0, lastNullable);
}
/**
 * Produce a description of the query regarding its nullability.
 *
 * Leaf nodes are not present in this representation since they are not
 * interesting for removing branches of the response tree.
 *
 * The structure is recursive like the query.
 * @param {CompilationContext} compilationContext Execution content
 * @returns {QueryMetadata} description of the query
 */
function parseQueryNullables(compilationContext) {
    const type = graphql_1.getOperationRootType(compilationContext.schema, compilationContext.operation);
    const fields = ast_1.collectFields(compilationContext, type, compilationContext.operation.selectionSet, Object.create(null), Object.create(null));
    const properties = Object.create(null);
    for (const responseName of Object.keys(fields)) {
        const fieldType = ast_1.resolveFieldDef(compilationContext, type, fields[responseName]);
        if (!fieldType) {
            // if field does not exist, it should be ignored for compatibility concerns.
            // Usually, validation would stop it before getting here but this could be an old query
            continue;
        }
        const property = transformNode(compilationContext, fields[responseName], fieldType.type);
        if (property != null) {
            properties[responseName] = property;
        }
    }
    return {
        isNullable: true,
        children: properties
    };
}
/**
 * Processes a single node to produce a description of itself and its children.
 *
 * Leaf nodes are ignore and removed from the description
 * @param {CompilationContext} compilationContext
 * @param {FieldNode[]} fieldNodes list of fields
 * @param {GraphQLType} type Current type being processed.
 * @returns {QueryMetadata | null} null if node is a leaf, otherwise a desciption of the node and its children.
 */
function transformNode(compilationContext, fieldNodes, type) {
    if (graphql_1.isNonNullType(type)) {
        const nullable = transformNode(compilationContext, fieldNodes, type.ofType);
        if (nullable != null) {
            nullable.isNullable = false;
            return nullable;
        }
        return null;
    }
    if (graphql_1.isObjectType(type)) {
        const subfields = ast_1.collectSubfields(compilationContext, type, fieldNodes);
        const properties = Object.create(null);
        for (const responseName of Object.keys(subfields)) {
            const fieldType = ast_1.resolveFieldDef(compilationContext, type, subfields[responseName]);
            if (!fieldType) {
                // if field does not exist, it should be ignored for compatibility concerns.
                // Usually, validation would stop it before getting here but this could be an old query
                continue;
            }
            const property = transformNode(compilationContext, subfields[responseName], fieldType.type);
            if (property != null) {
                properties[responseName] = property;
            }
        }
        return {
            isNullable: true,
            children: properties
        };
    }
    if (graphql_1.isListType(type)) {
        const child = transformNode(compilationContext, fieldNodes, type.ofType);
        if (child != null) {
            return {
                isNullable: true,
                children: { [ARRAY_CHILD_NAME]: child }
            };
        }
        return {
            isNullable: true,
            children: {}
        };
    }
    if (type_1.isAbstractType(type)) {
        return compilationContext.schema.getPossibleTypes(type).reduce((res, t) => {
            const property = transformNode(compilationContext, fieldNodes, t);
            if (property != null) {
                // We do a deep merge because children can have subset of properties
                // TODO: Possible bug: two object with different nullability on objects.
                res.children = lodash_merge_1.default(res.children, property.children);
            }
            return res;
        }, {
            isNullable: true,
            children: {}
        });
    }
    // Scalars and enum are ignored since they are leaf values
    return null;
}
//# sourceMappingURL=non-null.js.map