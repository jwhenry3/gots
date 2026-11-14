package nest

import (
	"fmt"
	"reflect"
)

// providerDef is one entry in a module's DI registry. Instances are
// singletons (inited + cached instance), like Nest's default scope.
type providerDef struct {
	typ      reflect.Type
	ctor     reflect.Value // nil for instance providers
	instance reflect.Value
	inited   bool
}

// resolution pairs a provider with the module that owns it, so its own
// constructor dependencies resolve in the owner's module scope.
type resolution struct {
	def   *providerDef
	owner *Module
}

// lookup finds a provider of type t visible from module m. When external is
// true (resolution crossing a module boundary via imports), only exported
// providers are visible.
func (m *Module) lookup(t reflect.Type, external bool, seen map[*Module]bool) *resolution {
	if seen[m] {
		return nil
	}
	seen[m] = true
	if d, ok := m.providers[t]; ok && (!external || m.exports[t]) {
		return &resolution{def: d, owner: m}
	}
	for _, imp := range m.imports {
		if r := imp.lookup(t, true, seen); r != nil {
			return r
		}
	}
	return nil
}

// instantiateFn calls fn (a constructor taking injectable params resolved
// against owner) and returns its single result.
func instantiateFn(fn reflect.Value, owner *Module, resolving map[reflect.Type]bool) (reflect.Value, error) {
	ft := fn.Type()
	args := make([]reflect.Value, ft.NumIn())
	for i := range args {
		r := owner.lookup(ft.In(i), false, map[*Module]bool{})
		if r == nil {
			return reflect.Value{}, fmt.Errorf("cannot resolve dependency %v — is it a provider of this module or exported by an imported module?", ft.In(i))
		}
		v, err := r.instantiate(resolving)
		if err != nil {
			return reflect.Value{}, err
		}
		args[i] = v
	}
	return fn.Call(args)[0], nil
}

func (r *resolution) instantiate(resolving map[reflect.Type]bool) (reflect.Value, error) {
	d := r.def
	if d.inited {
		return d.instance, nil
	}
	if resolving[d.typ] {
		return reflect.Value{}, fmt.Errorf("circular dependency while resolving %v", d.typ)
	}
	resolving[d.typ] = true
	defer delete(resolving, d.typ)
	v, err := instantiateFn(d.ctor, r.owner, resolving)
	if err != nil {
		return reflect.Value{}, fmt.Errorf("instantiating %v: %w", d.typ, err)
	}
	d.instance = v
	d.inited = true
	return v, nil
}

// walk visits every module in the import graph exactly once.
func walk(m *Module, seen map[*Module]bool, fn func(*Module)) {
	if seen[m] {
		return
	}
	seen[m] = true
	for _, imp := range m.imports {
		walk(imp, seen, fn)
	}
	fn(m)
}
