"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPromiseInliner = exports.isPromise = exports.createBoundQuery = exports.isCompiledQuery = exports.compileQuery = exports.GLOBAL_VARIABLES_NAME = void 0;
const fast_json_stringify_1 = __importDefault(require("fast-json-stringify"));
const generate_function_1 = __importDefault(require("generate-function"));
const graphql_1 = require("graphql");
const ast_1 = require("./ast");
const error_1 = require("./error");
const inspect_1 = __importDefault(require("./inspect"));
const json_1 = require("./json");
const non_null_1 = require("./non-null");
const resolve_info_1 = require("./resolve-info");
const variables_1 = require("./variables");
const inspect = inspect_1.default();
// prefix for the variable used ot cache validation results
const SAFETY_CHECK_PREFIX = "__validNode";
const GLOBAL_DATA_NAME = "__context.data";
const GLOBAL_ERRORS_NAME = "__context.errors";
const GLOBAL_NULL_ERRORS_NAME = "__context.nullErrors";
const GLOBAL_ROOT_NAME = "__context.rootValue";
exports.GLOBAL_VARIABLES_NAME = "__context.variables";
const GLOBAL_CONTEXT_NAME = "__context.context";
const GLOBAL_EXECUTION_CONTEXT = "__context";
const GLOBAL_PROMISE_COUNTER = "__context.promiseCounter";
const GLOBAL_INSPECT_NAME = "__context.inspect";
const GLOBAL_SAFE_MAP_NAME = "__context.safeMap";
const GRAPHQL_ERROR = "__context.GraphQLError";
const GLOBAL_RESOLVE = "__context.resolve";
const GLOBAL_PARENT_NAME = "__parent";
const LOCAL_JS_FIELD_NAME_PREFIX = "__field";
/**
 * It compiles a GraphQL query to an executable function
 * @param {GraphQLSchema} schema GraphQL schema
 * @param {DocumentNode} document Query being submitted
 * @param {string} operationName name of the operation
 * @param partialOptions compilation options to tune the compiler features
 * @returns {CompiledQuery} the cacheable result
 */
function compileQuery(schema, document, operationName, partialOptions) {
    if (!schema) {
        throw new Error(`Expected ${schema} to be a GraphQL schema.`);
    }
    if (!document) {
        throw new Error("Must provide document");
    }
    if (partialOptions &&
        partialOptions.resolverInfoEnricher &&
        typeof partialOptions.resolverInfoEnricher !== "function") {
        throw new Error("resolverInfoEnricher must be a function");
    }
    try {
        const options = Object.assign({ disablingCapturingStackErrors: false, customJSONSerializer: false, disableLeafSerialization: false, customSerializers: {}, variablesCircularReferenceCheck: false }, partialOptions);
        // If a valid context cannot be created due to incorrect arguments,
        // a "Response" with only errors is returned.
        const context = buildCompilationContext(schema, document, options, operationName);
        let stringify;
        if (options.customJSONSerializer) {
            const jsonSchema = json_1.queryToJSONSchema(context);
            stringify = fast_json_stringify_1.default(jsonSchema);
        }
        else {
            stringify = JSON.stringify;
        }
        const getVariables = variables_1.compileVariableParsing(schema, {
            variablesCircularReferenceCheck: options.variablesCircularReferenceCheck
        }, context.operation.variableDefinitions || []);
        const functionBody = compileOperation(context);
        const compiledQuery = {
            query: createBoundQuery(context, document, new Function("return " + functionBody)(), getVariables, context.operation.name != null
                ? context.operation.name.value
                : undefined),
            stringify
        };
        if (options.debug) {
            // result of the compilation useful for debugging issues
            // and visualization tools like try-jit.
            compiledQuery.__DO_NOT_USE_THIS_OR_YOU_WILL_BE_FIRED_compilation = functionBody;
        }
        return compiledQuery;
    }
    catch (err) {
        return {
            errors: normalizeErrors(err)
        };
    }
}
exports.compileQuery = compileQuery;
function isCompiledQuery(query) {
    return "query" in query && typeof query.query === "function";
}
exports.isCompiledQuery = isCompiledQuery;
// Exported only for an error test
function createBoundQuery(compilationContext, document, func, getVariableValues, operationName) {
    const { resolvers, typeResolvers, isTypeOfs, serializers, resolveInfos } = compilationContext;
    const trimmer = non_null_1.createNullTrimmer(compilationContext);
    const fnName = operationName ? operationName : "query";
    /* tslint:disable */
    /**
     * In-order to assign a debuggable name to the bound query function,
     * we create an intermediate object with a method named as the
     * intended function name. This is because Function.prototype.name
     * is not writeable.
     *
     * http://www.ecma-international.org/ecma-262/6.0/#sec-method-definitions-runtime-semantics-propertydefinitionevaluation
     *
     * section: 14.3.9.3 - calls SetFunctionName
     */
    /* tslint:enable */
    const ret = {
        [fnName](rootValue, context, variables) {
            // this can be shared across in a batch request
            const parsedVariables = getVariableValues(variables || {});
            // Return early errors if variable coercing failed.
            if (variables_1.failToParseVariables(parsedVariables)) {
                return { errors: parsedVariables.errors };
            }
            const executionContext = {
                rootValue,
                context,
                variables: parsedVariables.coerced,
                safeMap,
                inspect,
                GraphQLError: error_1.GraphQLError,
                resolvers,
                typeResolvers,
                isTypeOfs,
                serializers,
                resolveInfos,
                trimmer,
                promiseCounter: 0,
                data: {},
                nullErrors: [],
                errors: []
            };
            const result = func.call(null, executionContext);
            if (isPromise(result)) {
                return result.then(postProcessResult);
            }
            return postProcessResult(executionContext);
        }
    };
    return ret[fnName];
}
exports.createBoundQuery = createBoundQuery;
function postProcessResult({ data, nullErrors, errors, trimmer }) {
    if (nullErrors.length > 0) {
        const trimmed = trimmer(data, nullErrors);
        return {
            data: trimmed.data,
            errors: errors.concat(trimmed.errors)
        };
    }
    else if (errors.length > 0) {
        return {
            data,
            errors
        };
    }
    return { data };
}
/**
 * Create the main function body.
 *
 * Implements the "Evaluating operations" section of the spec.
 *
 * It defers all top level field for consistency and protection for null root values,
 * all the fields are deferred regardless of presence of resolver or not.
 *
 * @param {CompilationContext} context compilation context with the execution context
 * @returns {string} a function body to be instantiated together with the header, footer
 */
function compileOperation(context) {
    const type = graphql_1.getOperationRootType(context.schema, context.operation);
    const serialExecution = context.operation.operation === "mutation";
    const fieldMap = ast_1.collectFields(context, type, context.operation.selectionSet, Object.create(null), Object.create(null));
    const topLevel = compileObjectType(context, type, [], [GLOBAL_ROOT_NAME], [GLOBAL_DATA_NAME], undefined, GLOBAL_ERRORS_NAME, fieldMap, true);
    let body = `function query (${GLOBAL_EXECUTION_CONTEXT}) {
  "use strict";
`;
    if (serialExecution) {
        body += `${GLOBAL_EXECUTION_CONTEXT}.queue = [];`;
    }
    body += generateUniqueDeclarations(context, true);
    body += `${GLOBAL_DATA_NAME} = ${topLevel}\n`;
    if (serialExecution) {
        body += compileDeferredFieldsSerially(context);
        body += `
    ${GLOBAL_EXECUTION_CONTEXT}.finalResolve = () => {};
    ${GLOBAL_RESOLVE} = (context) => {
      if (context.jobCounter >= context.queue.length) {
        // All mutations have finished
        context.finalResolve(context);
        return;
      }
      context.queue[context.jobCounter++](context);
    };
    // There might not be a job to run due to invalid queries
    if (${GLOBAL_EXECUTION_CONTEXT}.queue.length > 0) {
      ${GLOBAL_EXECUTION_CONTEXT}.jobCounter = 1; // since the first one will be run manually
      ${GLOBAL_EXECUTION_CONTEXT}.queue[0](${GLOBAL_EXECUTION_CONTEXT});
    }
    // Promises have been scheduled so a new promise is returned
    // that will be resolved once every promise is done
    if (${GLOBAL_PROMISE_COUNTER} > 0) {
      return new Promise(resolve => ${GLOBAL_EXECUTION_CONTEXT}.finalResolve = resolve);
    }
  `;
    }
    else {
        body += compileDeferredFields(context);
        body += `
    // Promises have been scheduled so a new promise is returned
    // that will be resolved once every promise is done
    if (${GLOBAL_PROMISE_COUNTER} > 0) {
      return new Promise(resolve => ${GLOBAL_RESOLVE} = resolve);
    }`;
    }
    body += `
  // sync execution, the results are ready
  return undefined;
  }`;
    body += context.hoistedFunctions.join("\n");
    return body;
}
/**
 * Processes the deferred node list in the compilation context.
 *
 * Each deferred node get a copy of the compilation context with
 * a new empty list for deferred nodes to properly scope the nodes.
 * @param {CompilationContext} context compilation context
 * @returns {string} compiled transformations all of deferred nodes
 */
function compileDeferredFields(context) {
    let body = "";
    context.deferred.forEach((deferredField, index) => {
        body += `
      if (${SAFETY_CHECK_PREFIX}${index}) {
        ${compileDeferredField(context, deferredField)}
      }`;
    });
    return body;
}
function compileDeferredField(context, deferredField, appendix) {
    const { name, originPaths, destinationPaths, fieldNodes, fieldType, fieldName, jsFieldName, responsePath, parentType, args } = deferredField;
    const subContext = createSubCompilationContext(context);
    const nodeBody = compileType(subContext, parentType, fieldType, fieldNodes, [jsFieldName], [`${GLOBAL_PARENT_NAME}.${name}`], responsePath);
    const parentIndexes = getParentArgIndexes(context);
    const resolverName = getResolverName(parentType.name, fieldName);
    const resolverHandler = getHoistedFunctionName(context, `${name}${resolverName}Handler`);
    const topLevelArgs = getArgumentsName(resolverName);
    const validArgs = getValidArgumentsVarName(resolverName);
    const executionError = createErrorObject(context, fieldNodes, responsePath, "err.message != null ? err.message : err", "err");
    const executionInfo = getExecutionInfo(subContext, parentType, fieldType, fieldName, fieldNodes, responsePath);
    const emptyError = createErrorObject(context, fieldNodes, responsePath, '""');
    const resolverParentPath = originPaths.join(".");
    const resolverCall = `${GLOBAL_EXECUTION_CONTEXT}.resolvers.${resolverName}(
          ${resolverParentPath},${topLevelArgs},${GLOBAL_CONTEXT_NAME}, ${executionInfo})`;
    const resultParentPath = destinationPaths.join(".");
    const compiledArgs = compileArguments(subContext, args, topLevelArgs, validArgs, fieldType, responsePath);
    const body = `
    ${compiledArgs}
    if (${validArgs} === true) {
      var __value = null;
      try {
        __value = ${resolverCall};
      } catch (err) {
        ${getErrorDestination(fieldType)}.push(${executionError});
      }
      if (${isPromiseInliner("__value")}) {
      ${promiseStarted()}
       __value.then(result => {
        ${resolverHandler}(${GLOBAL_EXECUTION_CONTEXT}, ${resultParentPath}, result, ${parentIndexes});
        ${promiseDone()}
       }, err => {
        if (err) {
          ${getErrorDestination(fieldType)}.push(${executionError});
        } else {
          ${getErrorDestination(fieldType)}.push(${emptyError});
        }
        ${promiseDone()}
       });
      } else {
        ${resolverHandler}(${GLOBAL_EXECUTION_CONTEXT}, ${resultParentPath}, __value, ${parentIndexes});
      }
    }`;
    context.hoistedFunctions.push(`
    function ${resolverHandler}(${GLOBAL_EXECUTION_CONTEXT}, ${GLOBAL_PARENT_NAME}, ${jsFieldName}, ${parentIndexes}) {
      ${generateUniqueDeclarations(subContext)}
      ${GLOBAL_PARENT_NAME}.${name} = ${nodeBody};
      ${compileDeferredFields(subContext)}
      ${appendix ? appendix : ""}
    }
  `);
    return body;
}
function compileDeferredFieldsSerially(context) {
    let body = "";
    context.deferred.forEach(deferredField => {
        const { name, fieldName, parentType } = deferredField;
        const resolverName = getResolverName(parentType.name, fieldName);
        const mutationHandler = getHoistedFunctionName(context, `${name}${resolverName}Mutation`);
        body += `${GLOBAL_EXECUTION_CONTEXT}.queue.push(${mutationHandler});\n`;
        const appendix = `
    if (${GLOBAL_PROMISE_COUNTER} === 0) {
      ${GLOBAL_RESOLVE}(${GLOBAL_EXECUTION_CONTEXT});
    }
    `;
        context.hoistedFunctions.push(`
      function ${mutationHandler}(${GLOBAL_EXECUTION_CONTEXT}) {
        ${compileDeferredField(context, deferredField, appendix)}
      }
      `);
    });
    return body;
}
/**
 * Processes a generic node.
 *
 * The type is analysed and later reprocessed in dedicated functions.
 * @param {CompilationContext} context compilation context to hold deferred nodes
 * @param parentType
 * @param {GraphQLType} type type of current parent node
 * @param {FieldNode[]} fieldNodes array of the field nodes
 * @param originPaths originPaths path in the parent object from where to fetch results
 * @param destinationPaths path in the where to write the result
 * @param previousPath response path until this node
 * @returns {string} body of the resolvable fieldNodes
 */
function compileType(context, parentType, type, fieldNodes, originPaths, destinationPaths, previousPath) {
    const sourcePath = originPaths.join(".");
    let body = `${sourcePath} == null ? `;
    let errorDestination;
    if (graphql_1.isNonNullType(type)) {
        type = type.ofType;
        const nullErrorStr = `"Cannot return null for non-nullable field ${parentType.name}.${getFieldNodesName(fieldNodes)}."`;
        body += `(${GLOBAL_NULL_ERRORS_NAME}.push(${createErrorObject(context, fieldNodes, previousPath, nullErrorStr)}), null) :`;
        errorDestination = GLOBAL_NULL_ERRORS_NAME;
    }
    else {
        body += "null : ";
        errorDestination = GLOBAL_ERRORS_NAME;
    }
    body += "(";
    // value can be an error obj
    const errorPath = `${sourcePath}.message != null ? ${sourcePath}.message : ${sourcePath}`;
    body += `${sourcePath} instanceof Error ? (${errorDestination}.push(${createErrorObject(context, fieldNodes, previousPath, errorPath, sourcePath)}), null) : `;
    if (graphql_1.isLeafType(type)) {
        body += compileLeafType(context, type, originPaths, fieldNodes, previousPath, errorDestination);
    }
    else if (graphql_1.isObjectType(type)) {
        const fieldMap = ast_1.collectSubfields(context, type, fieldNodes);
        body += compileObjectType(context, type, fieldNodes, originPaths, destinationPaths, previousPath, errorDestination, fieldMap, false);
    }
    else if (graphql_1.isAbstractType(type)) {
        body += compileAbstractType(context, parentType, type, fieldNodes, originPaths, previousPath, errorDestination);
    }
    else if (graphql_1.isListType(type)) {
        body += compileListType(context, parentType, type, fieldNodes, originPaths, previousPath, errorDestination);
    }
    else {
        /* istanbul ignore next */
        throw new Error(`unsupported type: ${type.toString()}`);
    }
    body += ")";
    return body;
}
function compileLeafType(context, type, originPaths, fieldNodes, previousPath, errorDestination) {
    let body = "";
    if (context.options.disableLeafSerialization &&
        (type instanceof graphql_1.GraphQLEnumType || graphql_1.isSpecifiedScalarType(type))) {
        body += `${originPaths.join(".")}`;
    }
    else {
        const serializerName = getSerializerName(type.name);
        context.serializers[serializerName] = getSerializer(type, context.options.customSerializers[type.name]);
        const parentIndexes = getParentArgIndexes(context);
        const serializerErrorHandler = getHoistedFunctionName(context, `${type.name}${originPaths.join("")}SerializerErrorHandler`);
        context.hoistedFunctions.push(`
    function ${serializerErrorHandler}(${GLOBAL_EXECUTION_CONTEXT}, message, ${parentIndexes}) {
    ${errorDestination}.push(${createErrorObject(context, fieldNodes, previousPath, "message")});}
    `);
        body += `${GLOBAL_EXECUTION_CONTEXT}.serializers.${serializerName}(${GLOBAL_EXECUTION_CONTEXT}, ${originPaths.join(".")}, ${serializerErrorHandler}, ${parentIndexes})`;
    }
    return body;
}
/**
 * Compile a node of object type.
 * @param {CompilationContext} context
 * @param {GraphQLObjectType} type type of the node
 * @param fieldNodes fieldNodes array with the nodes references
 * @param originPaths originPaths path in the parent object from where to fetch results
 * @param destinationPaths path in the where to write the result
 * @param responsePath response path until this node
 * @param errorDestination Path for error array
 * @param fieldMap map of fields to fieldNodes array with the nodes references
 * @param alwaysDefer used to force the field to be resolved with a resolver ala graphql-js
 * @returns {string}
 */
function compileObjectType(context, type, fieldNodes, originPaths, destinationPaths, responsePath, errorDestination, fieldMap, alwaysDefer) {
    const body = generate_function_1.default();
    // Begin object compilation paren
    body("(");
    if (typeof type.isTypeOf === "function" && !alwaysDefer) {
        context.isTypeOfs[type.name + "IsTypeOf"] = type.isTypeOf;
        body(`!${GLOBAL_EXECUTION_CONTEXT}.isTypeOfs["${type.name}IsTypeOf"](${originPaths.join(".")}) ? (${errorDestination}.push(${createErrorObject(context, fieldNodes, responsePath, `\`Expected value of type "${type.name}" but got: $\{${GLOBAL_INSPECT_NAME}(${originPaths.join(".")})}.\``)}), null) :`);
    }
    // object start
    body("{");
    for (const name of Object.keys(fieldMap)) {
        const fieldNodes = fieldMap[name];
        const field = ast_1.resolveFieldDef(context, type, fieldNodes);
        if (!field) {
            // Field is invalid, should have been caught in validation
            // but the error is swallowed for compatibility reasons.
            continue;
        }
        // Key of the object
        // `name` is the field name or an alias supplied by the user
        body(`"${name}": `);
        /**
         * Value of the object
         *
         * The combined condition for whether a field should be included
         * in the object.
         *
         * Here, the logical operation is `||` because every fieldNode
         * is at the same level in the tree, if at least "one of" the nodes
         * is included, then the field is included.
         *
         * For example,
         *
         * ```graphql
         * {
         *   foo @skip(if: $c1)
         *   ... { foo @skip(if: $c2) }
         * }
         * ```
         *
         * The logic for `foo` becomes -
         *
         * `compilationFor($c1) || compilationFor($c2)`
         */
        body(`
      (
        ${fieldNodes
            .map(it => it.__internalShouldInclude)
            .filter(it => it)
            .join(" || ") || /* if(true) - default */ "true"}
      )
    `);
        // Inline __typename
        // No need to call a resolver for typename
        if (field === graphql_1.TypeNameMetaFieldDef) {
            // type.name if field is included else undefined - to remove from object
            // during serialization
            body(`? "${type.name}" : undefined,`);
            continue;
        }
        let resolver = field.resolve;
        if (!resolver && alwaysDefer) {
            const fieldName = field.name;
            resolver = parent => parent && parent[fieldName];
        }
        if (resolver) {
            context.deferred.push({
                name,
                responsePath: ast_1.addPath(responsePath, name),
                originPaths,
                destinationPaths,
                parentType: type,
                fieldName: field.name,
                jsFieldName: getJsFieldName(field.name),
                fieldType: field.type,
                fieldNodes,
                args: ast_1.getArgumentDefs(field, fieldNodes[0])
            });
            context.resolvers[getResolverName(type.name, field.name)] = resolver;
            body(`
          ? (
              ${SAFETY_CHECK_PREFIX}${context.deferred.length - 1} = true,
              null
            )
          : (
              ${SAFETY_CHECK_PREFIX}${context.deferred.length - 1} = false,
              undefined
            )
        `);
        }
        else {
            // if included
            body("?");
            body(compileType(context, type, field.type, fieldNodes, originPaths.concat(field.name), destinationPaths.concat(name), ast_1.addPath(responsePath, name)));
            // if not included
            body(": undefined");
        }
        // End object property
        body(",");
    }
    // End object
    body("}");
    // End object compilation paren
    body(")");
    return body.toString();
}
function compileAbstractType(context, parentType, type, fieldNodes, originPaths, previousPath, errorDestination) {
    let resolveType;
    if (type.resolveType) {
        resolveType = type.resolveType;
    }
    else {
        resolveType = (value, context, info) => defaultResolveTypeFn(value, context, info, type);
    }
    const typeResolverName = getTypeResolverName(type.name);
    context.typeResolvers[typeResolverName] = resolveType;
    const collectedTypes = context.schema
        .getPossibleTypes(type)
        .map(objectType => {
        const subContext = createSubCompilationContext(context);
        const object = compileType(subContext, parentType, objectType, fieldNodes, originPaths, ["__concrete"], ast_1.addPath(previousPath, objectType.name, "meta"));
        return `case "${objectType.name}": {
                  ${generateUniqueDeclarations(subContext)}
                  const __concrete = ${object};
                  ${compileDeferredFields(subContext)}
                  return __concrete;
              }`;
    })
        .join("\n");
    const finalTypeName = "finalType";
    const nullTypeError = `"Runtime Object type is not a possible type for \\"${type.name}\\"."`;
    // tslint:disable:max-line-length
    const notPossibleTypeError = '`Runtime Object type "${nodeType}" is not a possible type for "' +
        type.name +
        '".`';
    const noTypeError = `${finalTypeName} ? ${notPossibleTypeError} : "Abstract type ${type.name} must resolve to an Object type at runtime for field ${parentType.name}.${getFieldNodesName(fieldNodes)}. Either the ${type.name} type should provide a \\"resolveType\\" function or each possible types should provide an \\"isTypeOf\\" function."`;
    // tslint:enable:max-line-length
    return `((nodeType, err) =>
  {
    if (err != null) {
      ${errorDestination}.push(${createErrorObject(context, fieldNodes, previousPath, "err.message != null ? err.message : err", "err")});
      return null;
    }
    if (nodeType == null) {
      ${errorDestination}.push(${createErrorObject(context, fieldNodes, previousPath, nullTypeError)})
      return null;
    }
    const ${finalTypeName} = typeof nodeType === "string" ? nodeType : nodeType.name;
    switch(${finalTypeName}) {
      ${collectedTypes}
      default:
      ${errorDestination}.push(${createErrorObject(context, fieldNodes, previousPath, noTypeError)})
      return null;
    }
  })(
    ${GLOBAL_EXECUTION_CONTEXT}.typeResolvers.${typeResolverName}(${originPaths.join(".")},
    ${GLOBAL_CONTEXT_NAME},
    ${getExecutionInfo(context, parentType, type, type.name, fieldNodes, previousPath)}))`;
}
/**
 * Compile a list transformation.
 *
 * @param {CompilationContext} context
 * @param {GraphQLObjectType} parentType type of the parent of object which contained this type
 * @param {GraphQLList<GraphQLType>} type list type being compiled
 * @param {FieldNode[]} fieldNodes
 * @param originalObjectPaths
 * @param {ObjectPath} responsePath
 * @param errorDestination
 * @returns {string} compiled list transformation
 */
function compileListType(context, parentType, type, fieldNodes, originalObjectPaths, responsePath, errorDestination) {
    const name = originalObjectPaths.join(".");
    const listContext = createSubCompilationContext(context);
    // context depth will be mutated, so we cache the current value.
    const newDepth = ++listContext.depth;
    const fieldType = type.ofType;
    const dataBody = compileType(listContext, parentType, fieldType, fieldNodes, ["__currentItem"], [`${GLOBAL_PARENT_NAME}[idx${newDepth}]`], ast_1.addPath(responsePath, "idx" + newDepth, "variable"));
    const errorMessage = `"Expected Iterable, but did not find one for field ${parentType.name}.${getFieldNodesName(fieldNodes)}."`;
    const errorCase = `(${errorDestination}.push(${createErrorObject(context, fieldNodes, responsePath, errorMessage)}), null)`;
    const executionError = createErrorObject(context, fieldNodes, ast_1.addPath(responsePath, "idx" + newDepth, "variable"), "err.message != null ? err.message : err", "err");
    const emptyError = createErrorObject(context, fieldNodes, responsePath, '""');
    const uniqueDeclarations = generateUniqueDeclarations(listContext);
    const deferredFields = compileDeferredFields(listContext);
    const itemHandler = getHoistedFunctionName(context, `${parentType.name}${originalObjectPaths.join("")}MapItemHandler`);
    const childIndexes = getParentArgIndexes(listContext);
    listContext.hoistedFunctions.push(`
  function ${itemHandler}(${GLOBAL_EXECUTION_CONTEXT}, ${GLOBAL_PARENT_NAME}, __currentItem, ${childIndexes}) {
    ${uniqueDeclarations}
    ${GLOBAL_PARENT_NAME}[idx${newDepth}] = ${dataBody};
    ${deferredFields}
  }
  `);
    const safeMapHandler = getHoistedFunctionName(context, `${parentType.name}${originalObjectPaths.join("")}MapHandler`);
    const parentIndexes = getParentArgIndexes(context);
    listContext.hoistedFunctions.push(`
  function ${safeMapHandler}(${GLOBAL_EXECUTION_CONTEXT}, __currentItem, idx${newDepth}, resultArray, ${parentIndexes}) {
    if (${isPromiseInliner("__currentItem")}) {
      ${promiseStarted()}
      __currentItem.then(result => {
        ${itemHandler}(${GLOBAL_EXECUTION_CONTEXT}, resultArray, result, ${childIndexes});
        ${promiseDone()}
      }, err => {
        resultArray.push(null);
        if (err) {
          ${getErrorDestination(fieldType)}.push(${executionError});
        } else {
          ${getErrorDestination(fieldType)}.push(${emptyError});
        }
        ${promiseDone()}
      });
    } else {
       ${itemHandler}(${GLOBAL_EXECUTION_CONTEXT}, resultArray, __currentItem, ${childIndexes});
    }
  }
  `);
    return `(typeof ${name} === "string" || typeof ${name}[Symbol.iterator] !== "function") ?  ${errorCase} :
  ${GLOBAL_SAFE_MAP_NAME}(${GLOBAL_EXECUTION_CONTEXT}, ${name}, ${safeMapHandler}, ${parentIndexes})`;
}
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
function safeMap(context, iterable, cb, ...idx) {
    let index = 0;
    const result = [];
    for (const a of iterable) {
        cb(context, a, index, result, ...idx);
        ++index;
    }
    return result;
}
const MAGIC_MINUS_INFINITY = "__MAGIC_MINUS_INFINITY__71d4310a-d4a3-4a05-b1fe-e60779d24998";
const MAGIC_PLUS_INFINITY = "__MAGIC_PLUS_INFINITY__bb201c39-3333-4695-b4ad-7f1722e7aa7a";
const MAGIC_NAN = "__MAGIC_NAN__57f286b9-4c20-487f-b409-79804ddcb4f8";
function specialValueReplacer(_, value) {
    if (Number.isNaN(value)) {
        return MAGIC_NAN;
    }
    if (value === Infinity) {
        return MAGIC_PLUS_INFINITY;
    }
    if (value === -Infinity) {
        return MAGIC_MINUS_INFINITY;
    }
    return value;
}
function objectStringify(val) {
    return JSON.stringify(val, specialValueReplacer)
        .replace(`"${MAGIC_NAN}"`, "NaN")
        .replace(`"${MAGIC_PLUS_INFINITY}"`, "Infinity")
        .replace(`"${MAGIC_MINUS_INFINITY}"`, "-Infinity");
}
/**
 * Calculates a GraphQLResolveInfo object for the resolver calls.
 *
 * if the resolver does not use, it returns null.
 * @param {CompilationContext} context compilation context to submit the resolveInfoResolver
 * @param parentType
 * @param fieldType
 * @param fieldName
 * @param fieldNodes
 * @param responsePath
 * @returns {string} a call to the resolve info creator or "{}" if unused
 */
function getExecutionInfo(context, parentType, fieldType, fieldName, fieldNodes, responsePath) {
    const resolveInfoName = createResolveInfoName(responsePath);
    const { schema, fragments, operation } = context;
    context.resolveInfos[resolveInfoName] = resolve_info_1.createResolveInfoThunk({
        schema,
        fragments,
        operation,
        parentType,
        fieldName,
        fieldType,
        fieldNodes
    }, context.options.resolverInfoEnricher);
    return `${GLOBAL_EXECUTION_CONTEXT}.resolveInfos.${resolveInfoName}(${GLOBAL_ROOT_NAME}, ${exports.GLOBAL_VARIABLES_NAME}, ${serializeResponsePath(responsePath)})`;
}
function getArgumentsName(prefixName) {
    return `${prefixName}Args`;
}
function getValidArgumentsVarName(prefixName) {
    return `${prefixName}ValidArgs`;
}
function objectPath(topLevel, path) {
    if (!path) {
        return topLevel;
    }
    let objectPath = topLevel;
    const flattened = ast_1.flattenPath(path);
    for (const section of flattened) {
        if (section.type === "literal") {
            objectPath += `["${section.key}"]`;
        }
        else {
            /* istanbul ignore next */
            throw new Error("should only have received literal paths");
        }
    }
    return objectPath;
}
/**
 * Returns a static object with the all the arguments needed for the resolver
 * @param context
 * @param {Arguments} args
 * @param topLevelArg name of the toplevel
 * @param validArgs
 * @param returnType
 * @param path
 * @returns {string}
 */
function compileArguments(context, args, topLevelArg, validArgs, returnType, path) {
    // default to assuming arguments are valid
    let body = `
  let ${validArgs} = true;
  const ${topLevelArg} = ${objectStringify(args.values)};
  `;
    const errorDestination = getErrorDestination(returnType);
    for (const variable of args.missing) {
        const varName = variable.valueNode.name.value;
        body += `if (Object.prototype.hasOwnProperty.call(${exports.GLOBAL_VARIABLES_NAME}, "${varName}")) {`;
        if (variable.argument && graphql_1.isNonNullType(variable.argument.definition.type)) {
            const message = `'Argument "${variable.argument.definition.name}" of non-null type "${inspect(variable.argument.definition.type)}" must not be null.'`;
            body += `if (${exports.GLOBAL_VARIABLES_NAME}['${variable.valueNode.name.value}'] == null) {
      ${errorDestination}.push(${createErrorObject(context, [variable.argument.node.value], path, message)});
      ${validArgs} = false;
      }`;
        }
        body += `
    ${objectPath(topLevelArg, variable.path)} = ${exports.GLOBAL_VARIABLES_NAME}['${variable.valueNode.name.value}'];
    }`;
        // If there is no default value and no variable input
        // throw a field error
        if (variable.argument &&
            graphql_1.isNonNullType(variable.argument.definition.type) &&
            variable.argument.definition.defaultValue === undefined) {
            const message = `'Argument "${variable.argument.definition.name}" of required type "${inspect(variable.argument.definition.type)}" was provided the variable "$${varName}" which was not provided a runtime value.'`;
            body += ` else {
      ${errorDestination}.push(${createErrorObject(context, [variable.argument.node.value], path, message)});
      ${validArgs} = false;
        }`;
        }
    }
    return body;
}
/**
 *  Safety checks for resolver execution is done via side effects every time a resolver function
 *  is encountered.
 *
 *  This function generates the declarations, so the side effect is valid code.
 *
 * @param {CompilationContext} context compilation context
 * @param {boolean} defaultValue usually false, meant to be true at the top level
 * @returns {string} a list of declarations eg: var __validNode0 = false;\nvar __validNode1 = false;
 */
function generateUniqueDeclarations(context, defaultValue = false) {
    return context.deferred
        .map((_, idx) => `
        let ${SAFETY_CHECK_PREFIX}${idx} = ${defaultValue};
      `)
        .join("\n");
}
function createSubCompilationContext(context) {
    return Object.assign(Object.assign({}, context), { deferred: [] });
}
function isPromise(value) {
    return (value != null &&
        typeof value === "object" &&
        typeof value.then === "function");
}
exports.isPromise = isPromise;
function isPromiseInliner(value) {
    return `${value} != null && typeof ${value} === "object" && typeof ${value}.then === "function"`;
}
exports.isPromiseInliner = isPromiseInliner;
/**
 * Serializes the response path for an error response.
 *
 * @param {ObjectPath | undefined} path response path of a field
 * @returns {string} filtered serialization of the response path
 */
function serializeResponsePathAsArray(path) {
    const flattened = ast_1.flattenPath(path);
    let src = "[";
    for (let i = flattened.length - 1; i >= 0; i--) {
        // meta is only used for the function name
        if (flattened[i].type === "meta") {
            continue;
        }
        src +=
            flattened[i].type === "literal"
                ? `"${flattened[i].key}",`
                : `${flattened[i].key},`;
    }
    return src + "]";
}
function getErrorDestination(type) {
    return graphql_1.isNonNullType(type) ? GLOBAL_NULL_ERRORS_NAME : GLOBAL_ERRORS_NAME;
}
function createResolveInfoName(path) {
    return (ast_1.flattenPath(path)
        .map(p => p.key)
        .join("_") + "Info");
}
/**
 * Serializes the response path for the resolve info function
 * @param {ObjectPath | undefined} path response path of a field
 * @returns {string} filtered serialization of the response path
 */
function serializeResponsePath(path) {
    if (!path) {
        return "undefined";
    }
    if (path.type === "meta") {
        // meta is ignored while serializing for the resolve info functions
        return serializeResponsePath(path.prev);
    }
    const literalValue = `"${path.key}"`;
    return `{
    key:  ${path.type === "literal" ? literalValue : path.key},
    prev: ${serializeResponsePath(path.prev)}
  }`;
}
/**
 * Returned a bound serialization function of a scalar or enum
 * @param {GraphQLScalarType | GraphQLEnumType} scalar
 * @param customSerializer custom serializer
 * @returns {(v: any) => any} bound serializationFunction
 */
function getSerializer(scalar, customSerializer) {
    const { name } = scalar;
    const serialize = customSerializer
        ? customSerializer
        : (val) => scalar.serialize(val);
    return function leafSerializer(context, v, onError, ...idx) {
        try {
            const value = serialize(v);
            if (isInvalid(value)) {
                onError(context, `Expected a value of type "${name}" but received: ${v}`, ...idx);
                return null;
            }
            return value;
        }
        catch (e) {
            onError(context, (e && e.message) ||
                `Expected a value of type "${name}" but received an Error`, ...idx);
            return null;
        }
    };
}
/**
 * Default abstract type resolver.
 *
 * It only handle sync type resolving.
 * @param value
 * @param contextValue
 * @param {GraphQLResolveInfo} info
 * @param {GraphQLAbstractType} abstractType
 * @returns {string | GraphQLObjectType}
 */
function defaultResolveTypeFn(value, contextValue, info, abstractType) {
    // First, look for `__typename`.
    if (value != null &&
        typeof value === "object" &&
        typeof value.__typename === "string") {
        return value.__typename;
    }
    // Otherwise, test each possible type.
    const possibleTypes = info.schema.getPossibleTypes(abstractType);
    for (const type of possibleTypes) {
        if (type.isTypeOf) {
            const isTypeOfResult = type.isTypeOf(value, contextValue, info);
            if (isPromise(isTypeOfResult)) {
                throw new Error(`Promises are not supported for resolving type of ${value}`);
            }
            else if (isTypeOfResult) {
                return type;
            }
        }
    }
    throw new Error(`Could not resolve type of ${value}`);
}
/**
 * Constructs a ExecutionContext object from the arguments passed to
 * execute, which we will pass throughout the other execution methods.
 *
 * Throws a GraphQLError if a valid execution context cannot be created.
 */
function buildCompilationContext(schema, document, options, operationName) {
    const errors = [];
    let operation;
    let hasMultipleAssumedOperations = false;
    const fragments = Object.create(null);
    for (const definition of document.definitions) {
        switch (definition.kind) {
            case graphql_1.Kind.OPERATION_DEFINITION:
                if (!operationName && operation) {
                    hasMultipleAssumedOperations = true;
                }
                else if (!operationName ||
                    (definition.name && definition.name.value === operationName)) {
                    operation = definition;
                }
                break;
            case graphql_1.Kind.FRAGMENT_DEFINITION:
                fragments[definition.name.value] = definition;
                break;
        }
    }
    if (!operation) {
        if (operationName) {
            throw new graphql_1.GraphQLError(`Unknown operation named "${operationName}".`);
        }
        else {
            throw new graphql_1.GraphQLError("Must provide an operation.");
        }
    }
    else if (hasMultipleAssumedOperations) {
        throw new graphql_1.GraphQLError("Must provide operation name if query contains multiple operations.");
    }
    return {
        schema,
        fragments,
        rootValue: null,
        contextValue: null,
        operation,
        options,
        resolvers: {},
        serializers: {},
        typeResolvers: {},
        isTypeOfs: {},
        resolveInfos: {},
        hoistedFunctions: [],
        hoistedFunctionNames: new Map(),
        deferred: [],
        depth: -1,
        variableValues: {},
        fieldResolver: undefined,
        errors: errors
    };
}
function getFieldNodesName(nodes) {
    return nodes.length > 1
        ? "(" + nodes.map(({ name }) => name.value).join(",") + ")"
        : nodes[0].name.value;
}
function getHoistedFunctionName(context, name) {
    const count = context.hoistedFunctionNames.get(name);
    if (count === undefined) {
        context.hoistedFunctionNames.set(name, 0);
        return name;
    }
    context.hoistedFunctionNames.set(name, count + 1);
    return `${name}${count + 1}`;
}
function createErrorObject(context, nodes, path, message, originalError) {
    return `new ${GRAPHQL_ERROR}(${message},
    ${JSON.stringify(ast_1.computeLocations(nodes))},
      ${serializeResponsePathAsArray(path)},
      ${originalError ? originalError : "undefined"},
      ${context.options.disablingCapturingStackErrors ? "true" : "false"})`;
}
function getResolverName(parentName, name) {
    return parentName + name + "Resolver";
}
function getTypeResolverName(name) {
    return name + "TypeResolver";
}
function getSerializerName(name) {
    return name + "Serializer";
}
function promiseStarted() {
    return `
     // increase the promise counter
     ++${GLOBAL_PROMISE_COUNTER};
  `;
}
function promiseDone() {
    return `
    --${GLOBAL_PROMISE_COUNTER};
    if (${GLOBAL_PROMISE_COUNTER} === 0) {
      ${GLOBAL_RESOLVE}(${GLOBAL_EXECUTION_CONTEXT});
    }
  `;
}
function normalizeErrors(err) {
    if (Array.isArray(err)) {
        return err.map(e => normalizeError(e));
    }
    return [normalizeError(err)];
}
function normalizeError(err) {
    return err instanceof graphql_1.GraphQLError
        ? err
        : new error_1.GraphQLError(err.message, err.locations, err.path, err);
}
/**
 * Returns true if a value is undefined, or NaN.
 */
function isInvalid(value) {
    return value === undefined || value !== value;
}
function getParentArgIndexes(context) {
    let args = "";
    for (let i = 0; i <= context.depth; ++i) {
        if (i > 0) {
            args += ", ";
        }
        args += `idx${i}`;
    }
    return args;
}
function getJsFieldName(fieldName) {
    return `${LOCAL_JS_FIELD_NAME_PREFIX}${fieldName}`;
}
//# sourceMappingURL=execution.js.map