package nest

import (
	"bytes"
	"encoding/json"
	"net/http"
)

// Ctx is the request-scoped context handed to handlers, guards, and
// interceptors — the analogue of @Req()/@Res()/@Param()/@Query()/@Body().
type Ctx struct {
	w       http.ResponseWriter
	r       *http.Request
	app     *Application
	status  int
	written bool
}

// Request returns the underlying *http.Request.
func (c *Ctx) Request() *http.Request { return c.r }

// ResponseWriter returns the underlying http.ResponseWriter.
func (c *Ctx) ResponseWriter() http.ResponseWriter { return c.w }

// Param returns a path variable, like @Param("id"). Path params are declared
// in routes as /{id}.
func (c *Ctx) Param(name string) string { return c.r.PathValue(name) }

// Query returns a query-string value, like @Query("name").
func (c *Ctx) Query(name string) string { return c.r.URL.Query().Get(name) }

// Header returns a request header value.
func (c *Ctx) Header(name string) string { return c.r.Header.Get(name) }

// SetHeader sets a response header.
func (c *Ctx) SetHeader(name, value string) { c.w.Header().Set(name, value) }

// Validatable is implemented by DTOs that validate themselves after binding,
// the analogue of class-validator + ValidationPipe.
type Validatable interface {
	Validate() error
}

// Body decodes the JSON request body into v. If v implements Validatable it
// is validated immediately after decoding; a failure returns a
// BadRequestException-compatible error.
func (c *Ctx) Body(v any) error {
	if c.r.Body == nil || c.r.ContentLength == 0 {
		if vv, ok := v.(Validatable); ok {
			return vv.Validate()
		}
		return nil
	}
	if err := json.NewDecoder(c.r.Body).Decode(v); err != nil {
		return err
	}
	if vv, ok := v.(Validatable); ok {
		return vv.Validate()
	}
	return nil
}

// Status sets the HTTP status used when the handler's return value is
// written automatically — like @HttpCode(201).
func (c *Ctx) Status(code int) *Ctx {
	c.status = code
	return c
}

// JSON writes a JSON response immediately. Once called, the framework will
// not auto-write the handler's return value — like using @Res().
func (c *Ctx) JSON(status int, v any) {
	c.w.Header().Set("Content-Type", "application/json")
	c.w.WriteHeader(status)
	_ = json.NewEncoder(c.w).Encode(v)
	c.written = true
}

// Render executes a named template (registered via SetViews) and writes it as
// text/html — the analogue of @Render() for the View side of MVC.
func (c *Ctx) Render(name string, data any) error {
	if c.app.templates == nil {
		return InternalServerErrorException("no view engine configured")
	}
	var buf bytes.Buffer
	if err := c.app.templates.ExecuteTemplate(&buf, name, data); err != nil {
		return err
	}
	c.w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if c.status != 0 {
		c.w.WriteHeader(c.status)
	}
	_, err := c.w.Write(buf.Bytes())
	c.written = true
	return err
}

// Response is an explicit result a handler may return to control status,
// headers, and body — like returning a custom reply through @Res().
type Response struct {
	Status  int
	Body    any
	Headers map[string]string
}

// Res is a shorthand for building a Response.
func Res(status int, body any) *Response {
	return &Response{Status: status, Body: body}
}
