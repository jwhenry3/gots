package nest

import (
	"fmt"
	"reflect"
)

var (
	ctxType = reflect.TypeOf((*Ctx)(nil))
	errType = reflect.TypeOf((*error)(nil)).Elem()
	anyType = reflect.TypeOf((*any)(nil)).Elem()
)

// invoker calls a route handler: it binds the controller instance and *Ctx
// positionally, then fills any remaining struct-pointer parameters by
// decoding the JSON request body (@Body() equivalent).
type invoker func(ctrl reflect.Value, c *Ctx) (any, error)

// makeInvoker validates a handler's signature and compiles the call plan.
// Signature rules:
//
//	func(ctrl *T, ctx *Ctx[, body *DTO]) error
//	func(ctrl *T, ctx *Ctx[, body *DTO]) (any, error)
//
// Parameters after the controller may be *Ctx (the request context, in any
// position) or a pointer to a struct (bound from the JSON body).
func makeInvoker(h any, ctrlType reflect.Type) (invoker, error) {
	rv := reflect.ValueOf(h)
	rt := rv.Type()
	if rt.Kind() != reflect.Func {
		return nil, fmt.Errorf("handler must be a function, got %v", rt)
	}
	if rt.NumIn() < 1 || !reflect.PtrTo(ctrlType).AssignableTo(rt.In(0)) {
		return nil, fmt.Errorf("handler %v: first parameter must be *%v", rt, ctrlType)
	}
	if rt.NumOut() == 0 || rt.NumOut() > 2 || rt.Out(rt.NumOut()-1) != errType {
		return nil, fmt.Errorf("handler %v: must return error or (any, error)", rt)
	}
	if rt.NumOut() == 2 && !rt.Out(0).AssignableTo(anyType) {
		return nil, fmt.Errorf("handler %v: first return value must be assignable to any", rt)
	}

	// Classify the post-controller parameters.
	type paramKind int
	const (
		pCtx paramKind = iota
		pBody
	)
	kinds := make([]paramKind, 0, rt.NumIn()-1)
	for i := 1; i < rt.NumIn(); i++ {
		p := rt.In(i)
		if p == ctxType {
			kinds = append(kinds, pCtx)
		} else if p.Kind() == reflect.Ptr && p.Elem().Kind() == reflect.Struct {
			kinds = append(kinds, pBody)
		} else {
			return nil, fmt.Errorf("handler %v: parameter %d must be *Ctx or a struct pointer (body DTO)", rt, i+1)
		}
	}
	outs2 := rt.NumOut() == 2

	return func(ctrl reflect.Value, c *Ctx) (any, error) {
		args := []reflect.Value{ctrl}
		for i, k := range kinds {
			pt := rt.In(i + 1)
			if k == pCtx {
				args = append(args, reflect.ValueOf(c))
				continue
			}
			dto := reflect.New(pt.Elem())
			if err := c.Body(dto.Interface()); err != nil {
				return nil, BadRequestException(err.Error())
			}
			args = append(args, dto)
		}
		out := rv.Call(args)
		if e := out[len(out)-1]; !e.IsNil() {
			return nil, e.Interface().(error)
		}
		if !outs2 {
			return nil, nil
		}
		return out[0].Interface(), nil
	}, nil
}
