// go-ast-parse.go -- Go subprocess parser for @yakcc/shave-go (WI-870 slice 1).
//
// Reads Go source from stdin, parses it with go/ast, and writes a JSON
// envelope to stdout.  Exit code 0 on success; non-zero on error (error
// message on stderr).
//
// Wire shape (version=1):
//
//   {
//     "version": 1,
//     "packageName": "<package name>",
//     "functions": [
//       {
//         "name": "<func name>",
//         "receiver": "<receiver type string> | null",
//         "typeParams": [{ "name": "T", "constraint": "any" }, ...],
//         "params":   [{ "name": "<param name>", "goType": "<type string>" }, ...],
//         "results":  [{ "name": "<name or \"\">", "goType": "<type string>" }, ...],
//         "bodySource": "<verbatim body text> | null"
//       },
//       ...
//     ]
//   }
//
// All type strings are produced by go/printer (canonical Go formatting).
// Receiver, typeParams, and bodySource are slice-1 fields; body AST nodes
// are deferred to slice 2.
//
// Usage (from @yakcc/shave-go):
//   go run scripts/go-ast-parse.go < input.go

package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io"
	"os"
	"strings"
)

const schemaVersion = 1

type typeParam struct {
	Name       string `json:"name"`
	Constraint string `json:"constraint"`
}

type param struct {
	Name   string `json:"name"`
	GoType string `json:"goType"`
}

type functionEntry struct {
	Name       string      `json:"name"`
	Receiver   *string     `json:"receiver"`
	TypeParams []typeParam `json:"typeParams"`
	Params     []param     `json:"params"`
	Results    []param     `json:"results"`
	BodySource *string     `json:"bodySource"`
}

type envelope struct {
	Version     int             `json:"version"`
	PackageName string          `json:"packageName"`
	Functions   []functionEntry `json:"functions"`
}

func main() {
	src, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "go-ast-parse: read stdin: %v\n", err)
		os.Exit(1)
	}

	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "stdin.go", src, 0)
	if err != nil {
		fmt.Fprintf(os.Stderr, "go-ast-parse: parse error: %v\n", err)
		os.Exit(1)
	}

	functions := []functionEntry{}
	for _, decl := range f.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if !ok {
			continue
		}
		entry := buildFunctionEntry(fset, fd, src)
		functions = append(functions, entry)
	}

	out := envelope{
		Version:     schemaVersion,
		PackageName: f.Name.Name,
		Functions:   functions,
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "")
	if err := enc.Encode(out); err != nil {
		fmt.Fprintf(os.Stderr, "go-ast-parse: json encode: %v\n", err)
		os.Exit(1)
	}
}

func buildFunctionEntry(fset *token.FileSet, fd *ast.FuncDecl, src []byte) functionEntry {
	entry := functionEntry{
		TypeParams: []typeParam{},
		Params:     []param{},
		Results:    []param{},
	}

	entry.Name = fd.Name.Name

	// Receiver (method vs top-level function)
	if fd.Recv != nil && len(fd.Recv.List) > 0 {
		recv := typeExprToString(fset, fd.Recv.List[0].Type)
		entry.Receiver = &recv
	}

	// Generic type params (Go 1.18+)
	if fd.Type.TypeParams != nil {
		for _, field := range fd.Type.TypeParams.List {
			constraint := typeExprToString(fset, field.Type)
			for _, name := range field.Names {
				entry.TypeParams = append(entry.TypeParams, typeParam{
					Name:       name.Name,
					Constraint: constraint,
				})
			}
		}
	}

	// Input parameters
	if fd.Type.Params != nil {
		for _, field := range fd.Type.Params.List {
			goType := typeExprToString(fset, field.Type)
			if len(field.Names) == 0 {
				// Unnamed parameter
				entry.Params = append(entry.Params, param{Name: "", GoType: goType})
			}
			for _, name := range field.Names {
				entry.Params = append(entry.Params, param{Name: name.Name, GoType: goType})
			}
		}
	}

	// Return parameters
	if fd.Type.Results != nil {
		for _, field := range fd.Type.Results.List {
			goType := typeExprToString(fset, field.Type)
			if len(field.Names) == 0 {
				entry.Results = append(entry.Results, param{Name: "", GoType: goType})
			}
			for _, name := range field.Names {
				entry.Results = append(entry.Results, param{Name: name.Name, GoType: goType})
			}
		}
	}

	// Body source (verbatim, for slice 2 body raiser)
	if fd.Body != nil {
		start := fset.Position(fd.Body.Lbrace).Offset + 1 // after '{'
		end := fset.Position(fd.Body.Rbrace).Offset       // before '}'
		if start <= end && end <= len(src) {
			body := strings.TrimSpace(string(src[start:end]))
			entry.BodySource = &body
		}
	}

	return entry
}

// typeExprToString converts a go/ast type expression to its canonical Go
// source string using go/printer.
func typeExprToString(fset *token.FileSet, expr ast.Expr) string {
	var buf strings.Builder
	if err := printer.Fprint(&buf, fset, expr); err != nil {
		// Fallback: use the default Stringer for the AST node.
		return fmt.Sprintf("%v", expr)
	}
	return buf.String()
}
