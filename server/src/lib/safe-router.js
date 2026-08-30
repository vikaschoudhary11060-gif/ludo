/* ============================================================
   SafeRouter — an express.Router whose handlers can be async.

   Express 4 does not await route handlers: an async handler that
   rejects produces an unhandled promise rejection, the request
   hangs with no response, and Node 22 tears the process down.
   Every `throw` in our routes was that path.

   SafeRouter wraps each handler so a rejection is forwarded to
   next(err) and lands in the error middleware like any other
   failure. Use it everywhere instead of express.Router().
   ============================================================ */
import express from 'express';

/* Express routers and apps are themselves functions, so they must be
   mounted untouched — only real handlers get wrapped. */
const isRouterLike = fn => typeof fn === 'function' && (Array.isArray(fn.stack) || typeof fn.handle === 'function');

function wrap(fn) {
  if (typeof fn !== 'function' || isRouterLike(fn) || fn.__safeWrapped) return fn;

  // Error middleware is identified by arity, so the wrapper must keep it.
  const wrapped = fn.length === 4
    ? function (err, req, res, next) {
        try { return Promise.resolve(fn(err, req, res, next)).catch(next); }
        catch (e) { return next(e); }
      }
    : function (req, res, next) {
        try { return Promise.resolve(fn(req, res, next)).catch(next); }
        catch (e) { return next(e); }
      };

  wrapped.__safeWrapped = true;
  return wrapped;
}

/* param callbacks take (req, res, next, value) — a different arity from the
   handlers above, so they need their own wrapper. */
function wrapParam(fn) {
  if (fn.__safeWrapped) return fn;
  const wrapped = function (req, res, next, value) {
    try { return Promise.resolve(fn(req, res, next, value)).catch(next); }
    catch (e) { return next(e); }
  };
  wrapped.__safeWrapped = true;
  return wrapped;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all', 'use'];

/* Verbs available on the object router.route() returns. */
const ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all'];

export function SafeRouter(options) {
  const router = express.Router(options);
  for (const method of METHODS) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map(wrap));
  }

  /* router.route('/x').post(fn) registers on a Route object, bypassing the
     verbs patched above, so patch what route() hands back too. */
  const originalRoute = router.route.bind(router);
  router.route = (...args) => {
    const route = originalRoute(...args);
    for (const method of ROUTE_METHODS) {
      if (typeof route[method] !== 'function') continue;
      const original = route[method].bind(route);
      route[method] = (...handlers) => original(...handlers.map(wrap));
    }
    return route;
  };

  /* router.param(name, fn) resolves parameters and can be async. Express also
     accepts the deprecated one-argument param(fn) form, so wrap by position
     rather than assuming the callback is always the second argument. */
  const originalParam = router.param.bind(router);
  router.param = (...args) => {
    const last = args.length - 1;
    if (typeof args[last] === 'function') args[last] = wrapParam(args[last]);
    return originalParam(...args);
  };

  return router;
}

export default SafeRouter;
