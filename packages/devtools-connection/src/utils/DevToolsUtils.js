/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* General utilities used throughout devtools. */
var { Ci, Cu, Cc, components } = require("./chrome");
var promise = require("./promise");
const { AppConstants } = require("./appconstants");

/**
 * Turn the error |aError| into a string, without fail.
 */
exports.safeErrorString = function safeErrorString(aError) {
  try {
    let errorString = aError.toString();
    if (typeof errorString == "string") {
      // Attempt to attach a stack to |errorString|. If it throws an error, or
      // isn't a string, don't use it.
      try {
        if (aError.stack) {
          let stack = aError.stack.toString();
          if (typeof stack == "string") {
            errorString += `\nStack: ${stack}`;
          }
        }
      } catch (ee) {}

      // Append additional line and column number information to the output,
      // since it might not be part of the stringified error.
      if (
        typeof aError.lineNumber == "number" &&
        typeof aError.columnNumber == "number"
      ) {
        errorString += `Line: ${aError.lineNumber}, column: ${aError.columnNumber}`;
      }

      return errorString;
    }
  } catch (ee) {}

  // We failed to find a good error description, so do the next best thing.
  return Object.prototype.toString.call(aError);
};

/**
 * Report that |aWho| threw an exception, |aException|.
 */
exports.reportException = function reportException(aWho, aException) {
  let msg = `${aWho} threw an exception: ${exports.safeErrorString(aException)}`;

  console.log(msg);

  //  if (Cu && console.error) {
  //    /*
  //     * Note that the xpcshell test harness registers an observer for
  //     * console messages, so when we're running tests, this will cause
  //     * the test to quit.
  //     */
  //    console.error(msg);
  //  }
};

/**
 * Given a handler function that may throw, return an infallible handler
 * function that calls the fallible handler, and logs any exceptions it
 * throws.
 *
 * @param aHandler function
 *      A handler function, which may throw.
 * @param aName string
 *      A name for aHandler, for use in error messages. If omitted, we use
 *      aHandler.name.
 *
 * (SpiderMonkey does generate good names for anonymous functions, but we
 * don't have a way to get at them from JavaScript at the moment.)
 */
exports.makeInfallible = function makeInfallible(aHandler, aName) {
  if (!aName) {
    aName = aHandler.name;
  }

  return function(/* arguments */) {
    // try {
    return aHandler.apply(this, arguments);
    // } catch (ex) {
    //   let who = "Handler function";
    //   if (aName) {
    //     who += " " + aName;
    //   }
    //   return exports.reportException(who, ex);
    // }
  };
};

/**
 * Waits for the next tick in the event loop to execute a callback.
 */
exports.executeSoon = function executeSoon(aFn) {
  setTimeout(aFn, 0);
};

/**
 * Waits for the next tick in the event loop.
 *
 * @return Promise
 *         A promise that is resolved after the next tick in the event loop.
 */
exports.waitForTick = function waitForTick() {
  let deferred = promise.defer();
  exports.executeSoon(deferred.resolve);
  return deferred.promise;
};

/**
 * Waits for the specified amount of time to pass.
 *
 * @param number aDelay
 *        The amount of time to wait, in milliseconds.
 * @return Promise
 *         A promise that is resolved after the specified amount of time passes.
 */
exports.waitForTime = function waitForTime(aDelay) {
  let deferred = promise.defer();
  setTimeout(deferred.resolve, aDelay);
  return deferred.promise;
};

/**
 * Like Array.prototype.forEach, but doesn't cause jankiness when iterating over
 * very large arrays by yielding to the browser and continuing execution on the
 * next tick.
 *
 * @param Array aArray
 *        The array being iterated over.
 * @param Function aFn
 *        The function called on each item in the array. If a promise is
 *        returned by this function, iterating over the array will be paused
 *        until the respective promise is resolved.
 * @returns Promise
 *          A promise that is resolved once the whole array has been iterated
 *          over, and all promises returned by the aFn callback are resolved.
 */
exports.yieldingEach = function yieldingEach(aArray, aFn) {
  const deferred = promise.defer();

  let i = 0;
  let len = aArray.length;
  let outstanding = [deferred.promise];

  (function loop() {
    const start = Date.now();

    while (i < len) {
      // Don't block the main thread for longer than 16 ms at a time. To
      // maintain 60fps, you have to render every frame in at least 16ms; we
      // aren't including time spent in non-JS here, but this is Good
      // Enough(tm).
      if (Date.now() - start > 16) {
        exports.executeSoon(loop);
        return;
      }

      try {
        outstanding.push(aFn(aArray[i], i++));
      } catch (e) {
        deferred.reject(e);
        return;
      }
    }

    deferred.resolve();
  })();

  return promise.all(outstanding);
};

/**
 * Like XPCOMUtils.defineLazyGetter, but with a |this| sensitive getter that
 * allows the lazy getter to be defined on a prototype and work correctly with
 * instances.
 *
 * @param Object aObject
 *        The prototype object to define the lazy getter on.
 * @param String aKey
 *        The key to define the lazy getter on.
 * @param Function aCallback
 *        The callback that will be called to determine the value. Will be
 *        called with the |this| value of the current instance.
 */
exports.defineLazyPrototypeGetter = function defineLazyPrototypeGetter(
  aObject,
  aKey,
  aCallback,
) {
  Object.defineProperty(aObject, aKey, {
    configurable: true,
    get: function() {
      const value = aCallback.call(this);

      Object.defineProperty(this, aKey, {
        configurable: true,
        writable: true,
        value: value,
      });

      return value;
    },
  });
};

/**
 * Safely get the property value from a Debugger.Object for a given key. Walks
 * the prototype chain until the property is found.
 *
 * @param Debugger.Object aObject
 *        The Debugger.Object to get the value from.
 * @param String aKey
 *        The key to look for.
 * @return Any
 */
exports.getProperty = function getProperty(aObj, aKey) {
  let root = aObj;
  try {
    do {
      const desc = aObj.getOwnPropertyDescriptor(aKey);
      if (desc) {
        if ("value" in desc) {
          return desc.value;
        }
        // Call the getter if it's safe.
        return exports.hasSafeGetter(desc)
          ? desc.get.call(root).return
          : undefined;
      }
      aObj = aObj.proto;
    } while (aObj);
  } catch (e) {
    // If anything goes wrong report the error and return undefined.
    exports.reportException("getProperty", e);
  }
  return undefined;
};

/**
 * Determines if a descriptor has a getter which doesn't call into JavaScript.
 *
 * @param Object aDesc
 *        The descriptor to check for a safe getter.
 * @return Boolean
 *         Whether a safe getter was found.
 */
exports.hasSafeGetter = function hasSafeGetter(aDesc) {
  // Scripted functions that are CCWs will not appear scripted until after
  // unwrapping.
  try {
    let fn = aDesc.get.unwrap();
    return (
      fn && fn.callable && fn.class == "Function" && fn.script === undefined
    );
  } catch (e) {
    // Avoid exception 'Object in compartment marked as invisible to Debugger'
    return false;
  }
};

/**
 * Check if it is safe to read properties and execute methods from the given JS
 * object. Safety is defined as being protected from unintended code execution
 * from content scripts (or cross-compartment code).
 *
 * See bugs 945920 and 946752 for discussion.
 *
 * @type Object aObj
 *       The object to check.
 * @return Boolean
 *         True if it is safe to read properties from aObj, or false otherwise.
 */
exports.isSafeJSObject = function isSafeJSObject(aObj) {
  // If we are running on a worker thread, Cu is not available. In this case,
  // we always return false, just to be on the safe side.
  if (isWorker) {
    return false;
  }

  if (
    Cu.getGlobalForObject(aObj) == Cu.getGlobalForObject(exports.isSafeJSObject)
  ) {
    return true; // aObj is not a cross-compartment wrapper.
  }

  let principal = Cu.getObjectPrincipal(aObj);
  // if (Services.scriptSecurityManager.isSystemPrincipal(principal)) {
  //   return true; // allow chrome objects
  // }

  return Cu.isXrayWrapper(aObj);
};

exports.dumpn = function dumpn(str) {
  if (exports.dumpn.wantLogging) {
    console.log(`DBG-SERVER: ${str}\n`);
  }
};

// We want wantLogging to be writable. The exports object is frozen by the
// loader, so define it on dumpn instead.
exports.dumpn.wantLogging = false;

/**
 * A verbose logger for low-level tracing.
 */
exports.dumpv = function(msg) {
  if (exports.dumpv.wantVerbose) {
    exports.dumpn(msg);
  }
};

// We want wantLogging to be writable. The exports object is frozen by the
// loader, so define it on dumpn instead.
exports.dumpv.wantVerbose = false;

/**
 * Utility function for updating an object with the properties of
 * other objects.
 *
 * @param aTarget Object
 *        The object being updated.
 * @param aNewAttrs Object
 *        The rest params are objects to update aTarget with. You
 *        can pass as many as you like.
 */
exports.update = function update(aTarget, ...aArgs) {
  for (let attrs of aArgs) {
    for (let key in attrs) {
      let desc = Object.getOwnPropertyDescriptor(attrs, key);

      if (desc) {
        Object.defineProperty(aTarget, key, desc);
      }
    }
  }

  return aTarget;
};

/**
 * Utility function for getting the values from an object as an array
 *
 * @param aObject Object
 *        The object to iterate over
 */
exports.values = function values(aObject) {
  return Object.keys(aObject).map(k => aObject[k]);
};

/**
 * Defines a getter on a specified object that will be created upon first use.
 *
 * @param aObject
 *        The object to define the lazy getter on.
 * @param aName
 *        The name of the getter to define on aObject.
 * @param aLambda
 *        A function that returns what the getter should return.  This will
 *        only ever be called once.
 */
exports.defineLazyGetter = function defineLazyGetter(aObject, aName, aLambda) {
  Object.defineProperty(aObject, aName, {
    get: function() {
      delete aObject[aName];
      return (aObject[aName] = aLambda.apply(aObject));
    },
    configurable: true,
    enumerable: true,
  });
};

// DEPRECATED: use DevToolsUtils.assert(condition, message) instead!
let haveLoggedDeprecationMessage = false;
exports.dbg_assert = function dbg_assert(cond, e) {
  if (!haveLoggedDeprecationMessage) {
    haveLoggedDeprecationMessage = true;
    const deprecationMessage = `DevToolsUtils.dbg_assert is deprecated! Use DevToolsUtils.assert instead!${Error().stack}`;
    console.log(deprecationMessage);
    if (typeof console === "object" && console && console.warn) {
      console.warn(deprecationMessage);
    }
  }

  if (!cond) {
    return e;
  }
};

/**
 * No operation. The empty function.
 */
exports.noop = function() {};

function reallyAssert(condition, message) {
  if (!condition) {
    const err = new Error(`Assertion failure: ${message}`);
    exports.reportException("DevToolsUtils.assert", err);
    throw err;
  }
}

/**
 * DevToolsUtils.assert(condition, message)
 *
 * @param Boolean condition
 * @param String message
 *
 * Assertions are enabled when any of the following are true:
 *   - This is a DEBUG_JS_MODULES build
 *   - This is a DEBUG build
 *   - DevToolsUtils.testing is set to true
 *
 * If assertions are enabled, then `condition` is checked and if false-y, the
 * assertion failure is logged and then an error is thrown.
 *
 * If assertions are not enabled, then this function is a no-op.
 *
 * This is an improvement over `dbg_assert`, which doesn't actually cause any
 * fatal behavior, and is therefore much easier to accidentally ignore.
 */
Object.defineProperty(exports, "assert", {
  get: () =>
    (AppConstants.DEBUG || AppConstants.DEBUG_JS_MODULES || this.testing
      ? reallyAssert
      : exports.noop),
});

/**
 * Defines a getter on a specified object for a module.  The module will not
 * be imported until first use.
 *
 * @param aObject
 *        The object to define the lazy getter on.
 * @param aName
 *        The name of the getter to define on aObject for the module.
 * @param aResource
 *        The URL used to obtain the module.
 * @param aSymbol
 *        The name of the symbol exported by the module.
 *        This parameter is optional and defaults to aName.
 */
exports.defineLazyModuleGetter = function defineLazyModuleGetter(
  aObject,
  aName,
  aResource,
  aSymbol,
) {
  this.defineLazyGetter(aObject, aName, function XPCU_moduleLambda() {
    var temp = {};
    Cu.import(aResource, temp);
    return temp[aSymbol || aName];
  });
};

/**
 * Returns a promise that is resolved or rejected when all promises have settled
 * (resolved or rejected).
 *
 * This differs from Promise.all, which will reject immediately after the first
 * rejection, instead of waiting for the remaining promises to settle.
 *
 * @param values
 *        Iterable of promises that may be pending, resolved, or rejected. When
 *        when all promises have settled (resolved or rejected), the returned
 *        promise will be resolved or rejected as well.
 *
 * @return A new promise that is fulfilled when all values have settled
 *         (resolved or rejected). Its resolution value will be an array of all
 *         resolved values in the given order, or undefined if values is an
 *         empty array. The reject reason will be forwarded from the first
 *         promise in the list of given promises to be rejected.
 */
exports.settleAll = values => {
  if (values === null || typeof values[Symbol.iterator] != "function") {
    throw new Error("settleAll() expects an iterable.");
  }

  let deferred = promise.defer();

  values = Array.isArray(values) ? values : [...values];
  let countdown = values.length;
  let resolutionValues = new Array(countdown);
  let rejectionValue;
  let rejectionOccurred = false;

  if (!countdown) {
    deferred.resolve(resolutionValues);
    return deferred.promise;
  }

  function checkForCompletion() {
    if (--countdown > 0) {
      return;
    }
    if (!rejectionOccurred) {
      deferred.resolve(resolutionValues);
    } else {
      deferred.reject(rejectionValue);
    }
  }

  for (let i = 0; i < values.length; i++) {
    let index = i;
    let value = values[i];
    let resolver = result => {
      resolutionValues[index] = result;
      checkForCompletion();
    };
    let rejecter = error => {
      if (!rejectionOccurred) {
        rejectionValue = error;
        rejectionOccurred = true;
      }
      checkForCompletion();
    };

    if (value && typeof value.then == "function") {
      value.then(resolver, rejecter);
    } else {
      // Given value is not a promise, forward it as a resolution value.
      resolver(value);
    }
  }

  return deferred.promise;
};

/**
 * When the testing flag is set, various behaviors may be altered from
 * production mode, typically to enable easier testing or enhanced debugging.
 */
var testing = false;
Object.defineProperty(exports, "testing", {
  get: function() {
    return testing;
  },
  set: function(state) {
    testing = state;
  },
});

exports.isGenerator = function(fn) {
  if (typeof fn !== "function") {
    return false;
  }
  let proto = Object.getPrototypeOf(fn);
  if (!proto) {
    return false;
  }
  let ctor = proto.constructor;
  if (!ctor) {
    return false;
  }
  return ctor.name == "GeneratorFunction";
};

exports.isPromise = function(p) {
  return p && typeof p.then === "function";
};

/**
 * Return true if `thing` is a SavedFrame, false otherwise.
 */
exports.isSavedFrame = function(thing) {
  return Object.prototype.toString.call(thing) === "[object SavedFrame]";
};
