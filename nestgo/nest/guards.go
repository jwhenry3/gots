package nest

// Guard mirrors @UseGuards(). CanActivate runs before the handler; returning
// a non-nil error denies the request (return an *HttpError like
// UnauthorizedException for a proper status code, otherwise it becomes a 500).
type Guard interface {
	CanActivate(c *Ctx) error
}

// GuardFunc adapts a function to Guard.
type GuardFunc func(c *Ctx) error

func (f GuardFunc) CanActivate(c *Ctx) error { return f(c) }

// HandlerFunc is the call an Interceptor wraps.
type HandlerFunc func(c *Ctx) (any, error)

// Interceptor mirrors NestJS interceptors: it can run logic before and after
// the handler and may transform the returned value or error.
type Interceptor interface {
	Intercept(c *Ctx, next HandlerFunc) (any, error)
}

// InterceptorFunc adapts a function to Interceptor.
type InterceptorFunc func(c *Ctx, next HandlerFunc) (any, error)

func (f InterceptorFunc) Intercept(c *Ctx, next HandlerFunc) (any, error) {
	return f(c, next)
}

// RouteOption configures a single route (guards, interceptors).
type RouteOption func(*routeSpec)

// WithGuard attaches guards to a route, like @UseGuards() on a method.
func WithGuard(gs ...Guard) RouteOption {
	return func(r *routeSpec) { r.guards = append(r.guards, gs...) }
}

// WithInterceptor attaches interceptors to a route.
func WithInterceptor(is ...Interceptor) RouteOption {
	return func(r *routeSpec) { r.interceptors = append(r.interceptors, is...) }
}
