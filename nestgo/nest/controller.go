package nest

import (
	"net/http"
	"reflect"
	"strings"
)

// controllerSpec is the non-generic runtime form of a controller definition.
type controllerSpec struct {
	prefix       string
	ctor         any // func(deps...) *T — constructor-injected like providers
	instance     reflect.Value
	guards       []Guard
	interceptors []Interceptor
	routes       []routeSpec
}

type routeSpec struct {
	method       string
	path         string
	handler      any // func(ctrl *T, c *Ctx, body *DTO...) (res, error)
	guards       []Guard
	interceptors []Interceptor
}

// controllerRegistration lets Module.Controllers accept any builder.
type controllerRegistration interface {
	ctrlSpec() *controllerSpec
}

// ControllerBuilder accumulates routes for one controller, the way
// decorators accumulate metadata on a NestJS controller class:
//
//	nest.Controller("/users", NewUserController).
//	    Get("/",      (*UserController).FindAll).
//	    Get("/{id}",  (*UserController).FindOne).
//	    Post("/",     (*UserController).Create).
//	    Delete("/{id}", (*UserController).Remove, nest.WithGuard(AuthGuard{}))
//
// Handlers are method expressions: func(c *T, ctx *Ctx[, body *DTO]) (any, error).
// A struct-pointer parameter after *Ctx is bound from the JSON request body
// (and validated if it implements Validatable), like @Body() + ValidationPipe.
type ControllerBuilder struct {
	spec *controllerSpec
}

// Controller declares a controller with a route prefix, like @Controller("users").
// ctor is the controller's constructor; its parameters are DI-resolved.
func Controller(prefix string, ctor any) *ControllerBuilder {
	return &ControllerBuilder{spec: &controllerSpec{prefix: prefix, ctor: ctor}}
}

// Guards applies guards to every route on this controller (@UseGuards on the class).
func (b *ControllerBuilder) Guards(gs ...Guard) *ControllerBuilder {
	b.spec.guards = append(b.spec.guards, gs...)
	return b
}

// Interceptors applies interceptors to every route on this controller.
func (b *ControllerBuilder) Interceptors(is ...Interceptor) *ControllerBuilder {
	b.spec.interceptors = append(b.spec.interceptors, is...)
	return b
}

func (b *ControllerBuilder) route(method, path string, h any, opts ...RouteOption) *ControllerBuilder {
	r := routeSpec{method: method, path: path, handler: h}
	for _, o := range opts {
		o(&r)
	}
	b.spec.routes = append(b.spec.routes, r)
	return b
}

func (b *ControllerBuilder) Get(path string, h any, opts ...RouteOption) *ControllerBuilder {
	return b.route(http.MethodGet, path, h, opts...)
}

func (b *ControllerBuilder) Post(path string, h any, opts ...RouteOption) *ControllerBuilder {
	return b.route(http.MethodPost, path, h, opts...)
}

func (b *ControllerBuilder) Put(path string, h any, opts ...RouteOption) *ControllerBuilder {
	return b.route(http.MethodPut, path, h, opts...)
}

func (b *ControllerBuilder) Patch(path string, h any, opts ...RouteOption) *ControllerBuilder {
	return b.route(http.MethodPatch, path, h, opts...)
}

func (b *ControllerBuilder) Delete(path string, h any, opts ...RouteOption) *ControllerBuilder {
	return b.route(http.MethodDelete, path, h, opts...)
}

func (b *ControllerBuilder) ctrlSpec() *controllerSpec { return b.spec }

// joinPaths combines route segments, tolerating leading/trailing slashes.
func joinPaths(parts ...string) string {
	var out []string
	for _, p := range parts {
		p = strings.Trim(p, "/")
		if p != "" {
			out = append(out, p)
		}
	}
	return "/" + strings.Join(out, "/")
}
