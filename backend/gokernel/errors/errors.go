// Package errors provides typed API errors that serialize to the SAME JSON
// envelope + the SAME stable machine-readable codes as the Python kernel
// (backend/kernel/kernel/errors.py):
//
//	{ "error": { "code": "NOT_FOUND", "message": "...", "details": {...}? } }
//
// A handler returns one of these (or wraps a bare error) and Write() renders the
// envelope with the matching HTTP status, byte-compatible with the Python
// services so a client sees one error shape across the whole platform.
package errors

import (
	"encoding/json"
	"net/http"
)

// Stable machine-readable codes — identical strings to the Python kernel.
const (
	CodeBadRequest   = "BAD_REQUEST"
	CodeUnauthorized = "UNAUTHORIZED"
	CodeForbidden    = "FORBIDDEN"
	CodeNotFound     = "NOT_FOUND"
	CodeConflict     = "CONFLICT"
	CodeValidation   = "VALIDATION_ERROR"
	CodeRateLimited  = "RATE_LIMITED"
	CodeInternal     = "INTERNAL_ERROR"
)

// APIError is an application error carrying a stable code + HTTP status. It
// implements error, so it can flow through normal Go error handling.
type APIError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Status  int            `json:"-"`
	Details map[string]any `json:"details,omitempty"`
}

func (e *APIError) Error() string { return e.Code + ": " + e.Message }

// WithDetails attaches structured details (rendered under error.details).
func (e *APIError) WithDetails(d map[string]any) *APIError {
	e.Details = d
	return e
}

func newErr(code string, status int, message string) *APIError {
	return &APIError{Code: code, Message: message, Status: status}
}

// Constructors mirror the Python kernel's error subclasses.
func BadRequest(msg string) *APIError { return newErr(CodeBadRequest, http.StatusBadRequest, msg) }
func Unauthorized(msg string) *APIError {
	return newErr(CodeUnauthorized, http.StatusUnauthorized, msg)
}
func Forbidden(msg string) *APIError  { return newErr(CodeForbidden, http.StatusForbidden, msg) }
func NotFound(msg string) *APIError   { return newErr(CodeNotFound, http.StatusNotFound, msg) }
func Conflict(msg string) *APIError   { return newErr(CodeConflict, http.StatusConflict, msg) }
func Validation(msg string) *APIError { return newErr(CodeValidation, 422, msg) }
func Internal(msg string) *APIError   { return newErr(CodeInternal, http.StatusInternalServerError, msg) }

// envelope is the exact wire shape the Python kernel emits.
type envelope struct {
	Error envelopeBody `json:"error"`
}

type envelopeBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// Write renders err as the uniform error envelope. Any non-APIError becomes a
// safe 500 INTERNAL_ERROR with internals hidden (matching the Python catch-all).
func Write(w http.ResponseWriter, err error) {
	ae, ok := err.(*APIError)
	if !ok {
		ae = Internal("An unexpected error occurred")
	}
	body := envelope{Error: envelopeBody{
		Code:    ae.Code,
		Message: ae.Message,
		Details: ae.Details,
	}}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(ae.Status)
	_ = json.NewEncoder(w).Encode(body)
}

// WriteCode renders a bare code+message+status without constructing an APIError.
func WriteCode(w http.ResponseWriter, status int, code, message string) {
	Write(w, &APIError{Code: code, Message: message, Status: status})
}
