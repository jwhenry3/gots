package nest

import (
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
)

// Middleware is standard net/http middleware, applied globally in use order
// before routing — like app.use() / Nest middleware.
type Middleware func(http.Handler) http.Handler

// Application is the object returned by nest.Create — the analogue of
// INestApplication.
type Application struct {
	root         *Module
	mux          *http.ServeMux
	middlewares  []Middleware
	guards       []Guard
	interceptors []Interceptor
	filter       ExceptionFilter
	templates    *template.Template
	globalPrefix string
	mounted      bool
}

// Create instantiates the module graph (providers + controllers) and returns
// the application — NestFactory.create(AppModule).
func Create(root *Module) (*Application, error) {
	a := &Application{
		root:   root,
		mux:    http.NewServeMux(),
		filter: defaultFilter{},
	}
	resolving := map[reflect.Type]bool{}
	var bootErr error
	walk(root, map[*Module]bool{}, func(m *Module) {
		if bootErr != nil {
			return
		}
		// Eagerly instantiate every provider (Nest's default singleton scope),
		// so constructor wiring errors surface at bootstrap.
		for _, d := range m.providers {
			if _, err := (&resolution{def: d, owner: m}).instantiate(resolving); err != nil {
				bootErr = fmt.Errorf("module %s: %w", m.name, err)
				return
			}
		}
		for _, cs := range m.controllers {
			inst, err := instantiateFn(reflect.ValueOf(cs.ctor), m, map[reflect.Type]bool{})
			if err != nil {
				bootErr = fmt.Errorf("module %s controller: %w", m.name, err)
				return
			}
			if inst.Kind() != reflect.Ptr {
				bootErr = fmt.Errorf("module %s controller %s: constructor must return a pointer",
					m.name, inst.Type())
				return
			}
			cs.instance = inst
		}
	})
	if bootErr != nil {
		return nil, bootErr
	}
	return a, nil
}

// Use registers global middleware (standard net/http middleware).
func (a *Application) Use(mws ...Middleware) *Application {
	a.middlewares = append(a.middlewares, mws...)
	return a
}

// UseGuards registers global guards — app.useGlobalGuards().
func (a *Application) UseGuards(gs ...Guard) *Application {
	a.guards = append(a.guards, gs...)
	return a
}

// UseInterceptors registers global interceptors — app.useGlobalInterceptors().
func (a *Application) UseInterceptors(is ...Interceptor) *Application {
	a.interceptors = append(a.interceptors, is...)
	return a
}

// UseGlobalFilters replaces/extends the exception filter — app.useGlobalFilters().
func (a *Application) UseGlobalFilters(f ExceptionFilter) *Application {
	a.filter = f
	return a
}

// SetGlobalPrefix prefixes every route — app.setGlobalPrefix("api").
// Call before Listen/Handler.
func (a *Application) SetGlobalPrefix(prefix string) *Application {
	a.globalPrefix = prefix
	return a
}

// SetViews configures the view engine for Ctx.Render — like configure()
// calling setViewEngine/setBaseViewsDir in Nest. pattern is a
// template.ParseGlob pattern, e.g. "views/*.html". Relative patterns are
// resolved against the working directory first, then each ancestor, so the
// app runs identically from the module root or a subdirectory (go run ./src
// vs go run src).
func (a *Application) SetViews(pattern string) error {
	t, err := template.ParseGlob(pattern)
	if err == nil {
		a.templates = t
		return nil
	}
	if dir, wdErr := os.Getwd(); wdErr == nil {
		for {
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
			if t, ferr := template.ParseGlob(filepath.Join(dir, pattern)); ferr == nil {
				a.templates = t
				return nil
			}
		}
	}
	return err
}

// Inject resolves a provider instance by type after bootstrap — app.get().
// It searches all modules' providers regardless of export visibility.
func Inject[T any](a *Application) (*T, error) {
	t := reflect.TypeOf((*T)(nil))
	var found *resolution
	walk(a.root, map[*Module]bool{}, func(m *Module) {
		if found != nil {
			return
		}
		if d, ok := m.providers[t]; ok {
			found = &resolution{def: d, owner: m}
		}
	})
	if found == nil {
		return nil, fmt.Errorf("no provider for type %v", t)
	}
	v, err := found.instantiate(map[reflect.Type]bool{})
	if err != nil {
		return nil, err
	}
	svc, ok := v.Interface().(*T)
	if !ok {
		return nil, fmt.Errorf("provider %v is not *%v", v.Type(), t)
	}
	return svc, nil
}

// Handler returns the root http.Handler (for httptest), mounting routes lazily.
func (a *Application) Handler() http.Handler {
	a.mount()
	return a.rootHandler()
}

// Listen mounts routes and starts the HTTP server.
func (a *Application) Listen(addr string) error {
	a.mount()
	fmt.Printf("[nest] application listening on %s\n", addr)
	return http.ListenAndServe(addr, a.rootHandler())
}

func (a *Application) rootHandler() http.Handler {
	var h http.Handler = a.mux
	for i := len(a.middlewares) - 1; i >= 0; i-- {
		h = a.middlewares[i](h)
	}
	return h
}

// mount registers every route in the module tree on the ServeMux, exactly once.
func (a *Application) mount() {
	if a.mounted {
		return
	}
	a.mounted = true
	walk(a.root, map[*Module]bool{}, func(m *Module) {
		for _, cs := range m.controllers {
			for _, rs := range cs.routes {
				inv, err := makeInvoker(rs.handler, cs.instance.Elem().Type())
				if err != nil {
					panic(fmt.Sprintf("module %s route %s %s%s: %v",
						m.name, rs.method, cs.prefix, rs.path, err))
				}
				pattern := rs.method + " " + joinPaths(a.globalPrefix, cs.prefix, rs.path)
				a.mux.Handle(pattern, a.compose(cs, rs, inv))
				fmt.Printf("[nest] mapped %s\n", pattern)
			}
		}
	})
}

// compose builds the per-route request pipeline, ordered like Nest:
// (global middleware) → global guards → ctrl guards → route guards →
// global interceptors → ctrl interceptors → route interceptors → handler.
func (a *Application) compose(cs *controllerSpec, rs routeSpec, inv invoker) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c := &Ctx{w: w, r: r, app: a}
		res, err := a.pipeline(c, cs, rs, inv)
		a.writeResult(c, res, err)
	})
}

func (a *Application) pipeline(c *Ctx, cs *controllerSpec, rs routeSpec, inv invoker) (any, error) {
	for _, g := range append(append(append([]Guard{}, a.guards...), cs.guards...), rs.guards...) {
		if err := g.CanActivate(c); err != nil {
			return nil, err
		}
	}
	next := HandlerFunc(func(c *Ctx) (any, error) {
		return inv(cs.instance, c)
	})
	interceptors := append(append(append([]Interceptor{}, a.interceptors...), cs.interceptors...), rs.interceptors...)
	for i := len(interceptors) - 1; i >= 0; i-- {
		it := interceptors[i]
		inner := next
		next = func(c *Ctx) (any, error) { return it.Intercept(c, inner) }
	}
	return next(c)
}

// writeResult applies the exception filter on error, or serializes the
// handler result: *Response for explicit control, string for text/plain,
// everything else as JSON at ctx.Status() (default 200, or 204 for nil).
func (a *Application) writeResult(c *Ctx, res any, err error) {
	if err != nil {
		a.filter.Catch(err, c)
		return
	}
	if c.written {
		return
	}
	status := c.status
	body := res
	if rp, ok := res.(*Response); ok {
		for k, v := range rp.Headers {
			c.w.Header().Set(k, v)
		}
		if rp.Status != 0 {
			status = rp.Status
		}
		body = rp.Body
	}
	if status == 0 {
		if body == nil {
			status = http.StatusNoContent
		} else {
			status = http.StatusOK
		}
	}
	if body == nil {
		c.w.WriteHeader(status)
		return
	}
	if s, ok := body.(string); ok {
		c.w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		c.w.WriteHeader(status)
		_, _ = c.w.Write([]byte(s))
		return
	}
	c.w.Header().Set("Content-Type", "application/json")
	c.w.WriteHeader(status)
	_ = json.NewEncoder(c.w).Encode(body)
}

