"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fieldExpansionEnricher = exports.createResolveInfoThunk = exports.isLeafField = void 0;
const generate_function_1 = __importDefault(require("generate-function"));
const graphql_1 = require("graphql");
const lodash_memoize_1 = __importDefault(require("lodash.memoize"));
const lodash_mergewith_1 = __importDefault(require("lodash.mergewith"));
const memoize_1 = require("./memoize");
const LeafFieldSymbol = Symbol("LeafFieldSymbol");
function createLeafField(props) {
    return Object.assign({ [LeafFieldSymbol]: true }, props);
}
function isLeafField(obj) {
    return (obj != null && Object.prototype.hasOwnProperty.call(obj, LeafFieldSymbol));
}
exports.isLeafField = isLeafField;
/**
 * Compute the GraphQLJitResolveInfo's `fieldExpansion` and return a function
 * that returns the computed resolveInfo. This thunk is registered in
 * context.dependencies for the field's resolveInfoName
 */
function createResolveInfoThunk({ schema, fragments, operation, parentType, fieldName, fieldType, fieldNodes }, enricher) {
    let enrichedInfo = {};
    if (typeof enricher === "function") {
        enrichedInfo =
            enricher({
                fieldName,
                fieldNodes,
                returnType: fieldType,
                parentType,
                schema,
                fragments,
                operation
            }) || {};
        if (typeof enrichedInfo !== "object" || Array.isArray(enrichedInfo)) {
            enrichedInfo = {};
        }
    }
    const gen = generate_function_1.default();
    gen(`return function getGraphQLResolveInfo(rootValue, variableValues, path) {
      return {
          fieldName,
          fieldNodes,
          returnType: fieldType,
          parentType,
          path,
          schema,
          fragments,
          rootValue,
          operation,
          variableValues,`);
    Object.keys(enrichedInfo).forEach(key => {
        gen(`${key}: enrichedInfo["${key}"],\n`);
    });
    gen(`};};`);
    return new Function("fieldName", "fieldNodes", "fieldType", "parentType", "schema", "fragments", "operation", "enrichedInfo", gen.toString()).call(null, fieldName, fieldNodes, fieldType, parentType, schema, fragments, operation, enrichedInfo);
}
exports.createResolveInfoThunk = createResolveInfoThunk;
function fieldExpansionEnricher(input) {
    const { schema, fragments, returnType, fieldNodes } = input;
    const fieldExpansion = {};
    for (const fieldNode of fieldNodes) {
        deepMerge(fieldExpansion, memoizedExpandFieldNode(schema, fragments, fieldNode, returnType));
    }
    return {
        fieldExpansion
    };
}
exports.fieldExpansionEnricher = fieldExpansionEnricher;
const memoizedGetReturnType = memoize_1.memoize2(getReturnType);
const memoizedHasField = memoize_1.memoize2(hasField);
const memoizedResolveEndType = lodash_memoize_1.default(resolveEndType);
const memoizedGetPossibleTypes = memoize_1.memoize2(getPossibleTypes);
const memoizedExpandFieldNodeType = memoize_1.memoize4(expandFieldNodeType);
const memoizedExpandFieldNode = memoize_1.memoize4(expandFieldNode);
function expandFieldNode(schema, fragments, node, fieldType) {
    if (node.selectionSet == null) {
        return createLeafField({});
    }
    // there is a selectionSet which makes the fieldType a CompositeType
    const typ = memoizedResolveEndType(fieldType);
    const possibleTypes = memoizedGetPossibleTypes(schema, typ);
    const fieldExpansion = {};
    for (const possibleType of possibleTypes) {
        if (!graphql_1.isUnionType(possibleType)) {
            fieldExpansion[possibleType.name] = memoizedExpandFieldNodeType(schema, fragments, possibleType, node.selectionSet);
        }
    }
    return fieldExpansion;
}
function expandFieldNodeType(schema, fragments, parentType, selectionSet) {
    const typeExpansion = {};
    for (const selection of selectionSet.selections) {
        if (selection.kind === "Field") {
            if (!graphql_1.isUnionType(parentType) &&
                memoizedHasField(parentType, selection.name.value)) {
                typeExpansion[selection.name.value] = memoizedExpandFieldNode(schema, fragments, selection, memoizedGetReturnType(parentType, selection.name.value));
            }
        }
        else {
            const selectionSet = selection.kind === "InlineFragment"
                ? selection.selectionSet
                : fragments[selection.name.value].selectionSet;
            deepMerge(typeExpansion, memoizedExpandFieldNodeType(schema, fragments, parentType, selectionSet));
        }
    }
    return typeExpansion;
}
/**
 * Returns a list of Possible types that one can get to from the
 * resolvedType. As an analogy, these are the same types that one
 * can use in a fragment's typeCondition.
 *
 * Note: This is different from schema.getPossibleTypes() that this
 * returns all possible types and not just the ones from the type definition.
 *
 * Example:
 * interface Node {
 *   id: ID!
 * }
 * type User implements Node {
 *   id: ID!
 *   name: String
 * }
 * type Article implements Node {
 *   id: ID!
 *   title: String
 * }
 * union Card = User | Article
 *
 * - schema.getPossibleTypes(Card) would give [User, Article]
 * - This function getPossibleTypes(schema, Card) would give [User, Article, Node]
 *
 */
function getPossibleTypes(schema, compositeType) {
    if (graphql_1.isObjectType(compositeType)) {
        return [compositeType];
    }
    const possibleTypes = [];
    const types = schema.getTypeMap();
    for (const typeName in types) {
        if (Object.prototype.hasOwnProperty.call(types, typeName)) {
            const typ = types[typeName];
            if (graphql_1.isCompositeType(typ) && graphql_1.doTypesOverlap(schema, typ, compositeType)) {
                possibleTypes.push(typ);
            }
        }
    }
    return possibleTypes;
}
/**
 * Given an (Object|Interface)Type, and a fieldName, find the
 * appropriate `end` return type for the field in the Composite Type.
 *
 * Note: The `end` return type is the type by unwrapping non-null types
 * and list types. Check `resolveEndType`
 */
function getReturnType(parentType, fieldName) {
    const fields = parentType.getFields();
    if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) {
        throw new graphql_1.GraphQLError(`Field "${fieldName}" does not exist in "${parentType.name}"`);
    }
    const outputType = fields[fieldName].type;
    return memoizedResolveEndType(outputType);
}
/**
 * Resolve to the end type of the Output type unwrapping non-null types and lists
 */
function resolveEndType(typ) {
    if (graphql_1.isListType(typ) || graphql_1.isNonNullType(typ)) {
        return memoizedResolveEndType(typ.ofType);
    }
    return typ;
}
function hasField(typ, fieldName) {
    return Object.prototype.hasOwnProperty.call(typ.getFields(), fieldName);
}
// This is because lodash does not support merging keys
// which are symbols. We require them for leaf fields
function deepMerge(obj, src) {
    lodash_mergewith_1.default(obj, src, (objValue, srcValue) => {
        if (isLeafField(objValue)) {
            if (isLeafField(srcValue)) {
                return Object.assign(Object.assign({}, objValue), srcValue);
            }
            return objValue;
        }
        else if (isLeafField(srcValue)) {
            return srcValue;
        }
        return;
    });
}
//# sourceMappingURL=resolve-info.js.map