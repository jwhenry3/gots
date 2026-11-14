package nest

import (
	"errors"
	"fmt"
	"net/http"
)

// HttpError is the Go equivalent of NestJS HttpException. Handlers return
// these (or wrap them) and the exception filter maps them to JSON responses
// in the Nest style: {"statusCode": 404, "message": "..."}.
type HttpError struct {
	Status  int
	Message string
}

func (e *HttpError) Error() string { return e.Message }

func NewHttpError(status int, msg string) *HttpError {
	return &HttpError{Status: status, Message: msg}
}

func BadRequestException(msg string) *HttpError   { return NewHttpError(http.StatusBadRequest, msg) }
func UnauthorizedException(msg string) *HttpError { return NewHttpError(http.StatusUnauthorized, msg) }
func ForbiddenException(msg string) *HttpError    { return NewHttpError(http.StatusForbidden, msg) }
func NotFoundException(msg string) *HttpError     { return NewHttpError(http.StatusNotFound, msg) }
func ConflictException(msg string) *HttpError     { return NewHttpError(http.StatusConflict, msg) }
func InternalServerErrorException(msg string) *HttpError {
	return NewHttpError(http.StatusInternalServerError, msg)
}

// ExceptionFilter is the counterpart of @Catch() exception filters. It is
// invoked whenever a handler, guard, or interceptor returns an error.
type ExceptionFilter interface {
	Catch(err error, c *Ctx)
}

// ExceptionFilterFunc adapts a function to ExceptionFilter.
type ExceptionFilterFunc func(err error, c *Ctx)

func (f ExceptionFilterFunc) Catch(err error, c *Ctx) { f(err, c) }

// defaultFilter replicates Nest's built-in exception filter.
type defaultFilter struct{}

func (defaultFilter) Catch(err error, c *Ctx) {
	var he *HttpError
	if errors.As(err, &he) {
		c.JSON(he.Status, map[string]any{
			"statusCode": he.Status,
			"message":    he.Message,
		})
		return
	}
	c.JSON(http.StatusInternalServerError, map[string]any{
		"statusCode": http.StatusInternalServerError,
		"message":    "Internal server error",
	})
	// Unexpected errors are logged to the console like Nest's default filter.
	fmt.Printf("[nest] unhandled error on %s %s: %v\n", c.Request().Method, c.Request().URL.Path, err)
}
