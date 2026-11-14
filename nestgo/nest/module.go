package nest

import (
	"fmt"
	"reflect"
)

// Module is the Go equivalent of @Module(). Build it fluently:
//
//	nest.NewModule("UsersModule").
//	    Imports(CoreModule()).
//	    Controllers(nest.Controller("/users", NewUserController).
//	        Get("/", (*UserController).FindAll)).
//	    Providers(NewUserService).
//	    Exports(NewUserService)
type Module struct {
	name        string
	imports     []*Module
	controllers []*controllerSpec
	providers   map[reflect.Type]*providerDef
	exports     map[reflect.Type]bool
}

func NewModule(name string) *Module {
	return &Module{
		name:      name,
		providers: map[reflect.Type]*providerDef{},
		exports:   map[reflect.Type]bool{},
	}
}

// Imports registers modules whose exported providers become injectable here.
func (m *Module) Imports(mods ...*Module) *Module {
	m.imports = append(m.imports, mods...)
	return m
}

// Controllers registers controller builders on the module.
func (m *Module) Controllers(ctrls ...controllerRegistration) *Module {
	for _, c := range ctrls {
		m.controllers = append(m.controllers, c.ctrlSpec())
	}
	return m
}

// Providers registers injectables. Each argument is either:
//   - a constructor function: func(deps...) *T      (deps resolved by type)
//   - a prebuilt instance:    &T{...}               (value provider)
func (m *Module) Providers(providers ...any) *Module {
	for _, p := range providers {
		rv := reflect.ValueOf(p)
		rt := rv.Type()
		d := &providerDef{}
		if rt.Kind() == reflect.Func {
			if rt.NumOut() != 1 {
				panic(fmt.Sprintf("nest: provider constructor in %s must return exactly one value", m.name))
			}
			d.typ = rt.Out(0)
			d.ctor = rv
		} else {
			d.typ = rt
			d.instance = rv
			d.inited = true
		}
		m.providers[d.typ] = d
	}
	return m
}

// Exports marks providers (by constructor func or instance, same as
// Providers) as visible to modules that import this one — @Module exports.
func (m *Module) Exports(providers ...any) *Module {
	for _, p := range providers {
		t := reflect.TypeOf(p)
		if t.Kind() == reflect.Func {
			t = t.Out(0)
		}
		m.exports[t] = true
	}
	return m
}

func (m *Module) Name() string { return m.name }
