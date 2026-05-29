// go-ast-parse.go -- Go subprocess parser for @yakcc/shave-go (WI-870 slice 1+2).
//
// Reads Go source from stdin, parses it with go/ast, and writes a JSON
// envelope to stdout.  Exit code 0 on success; non-zero on error (error
// message on stderr).
//
// Wire shape (version=2):
//   "version": 2 (bumped from slice-1 v=1 to signal body AST field)
//   "body": GoBodyNode | null  -- structured body AST with source locations
//   "bodySource": string | null -- verbatim text, kept for diagnostics only
//
// Banned constructs emitted as distinguished node types so raise-body.ts can
// throw CannotRaiseToIRError without re-parsing text:
//   GoStmt, SelectStmt, DeferStmt, SendStmt, ChanRecv
//
// Usage:
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

const schemaVersion = 2

type typeParam struct {
	Name       string `json:"name"`
	Constraint string `json:"constraint"`
}

type param struct {
	Name   string `json:"name"`
	GoType string `json:"goType"`
}

type GoBodyNode struct {
	Stmts []json.RawMessage `json:"stmts"`
}

type functionEntry struct {
	Name       string      `json:"name"`
	Receiver   *string     `json:"receiver"`
	TypeParams []typeParam `json:"typeParams"`
	Params     []param     `json:"params"`
	Results    []param     `json:"results"`
	BodySource *string     `json:"bodySource"`
	Body       *GoBodyNode `json:"body"`
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

	if fd.Recv != nil && len(fd.Recv.List) > 0 {
		recv := typeExprToString(fset, fd.Recv.List[0].Type)
		entry.Receiver = &recv
	}

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

	if fd.Type.Params != nil {
		for _, field := range fd.Type.Params.List {
			goType := typeExprToString(fset, field.Type)
			if len(field.Names) == 0 {
				entry.Params = append(entry.Params, param{Name: "", GoType: goType})
			}
			for _, name := range field.Names {
				entry.Params = append(entry.Params, param{Name: name.Name, GoType: goType})
			}
		}
	}

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

	if fd.Body != nil {
		start := fset.Position(fd.Body.Lbrace).Offset + 1
		end := fset.Position(fd.Body.Rbrace).Offset
		if start <= end && end <= len(src) {
			body := strings.TrimSpace(string(src[start:end]))
			entry.BodySource = &body
		}

		bodyNode := buildBodyNode(fset, fd.Body)
		entry.Body = &bodyNode
	}

	return entry
}

func buildBodyNode(fset *token.FileSet, block *ast.BlockStmt) GoBodyNode {
	stmts := []json.RawMessage{}
	for _, stmt := range block.List {
		raw := marshalStmt(fset, stmt)
		stmts = append(stmts, raw)
	}
	return GoBodyNode{Stmts: stmts}
}

func position(fset *token.FileSet, pos token.Pos) (int, int) {
	p := fset.Position(pos)
	return p.Line, p.Column
}

func marshalStmt(fset *token.FileSet, stmt ast.Stmt) json.RawMessage {
	line, col := position(fset, stmt.Pos())

	switch s := stmt.(type) {
	case *ast.ReturnStmt:
		results := make([]json.RawMessage, len(s.Results))
		for i, r := range s.Results {
			results[i] = marshalExpr(fset, r)
		}
		return marshal(map[string]interface{}{
			"type":    "ReturnStmt",
			"line":    line,
			"col":     col,
			"results": results,
		})

	case *ast.ExprStmt:
		return marshal(map[string]interface{}{
			"type": "ExprStmt",
			"line": line,
			"col":  col,
			"x":    marshalExpr(fset, s.X),
		})

	case *ast.AssignStmt:
		lhs := make([]json.RawMessage, len(s.Lhs))
		for i, e := range s.Lhs {
			lhs[i] = marshalExpr(fset, e)
		}
		rhs := make([]json.RawMessage, len(s.Rhs))
		for i, e := range s.Rhs {
			rhs[i] = marshalExpr(fset, e)
		}
		return marshal(map[string]interface{}{
			"type": "AssignStmt",
			"line": line,
			"col":  col,
			"lhs":  lhs,
			"rhs":  rhs,
			"tok":  s.Tok.String(),
		})

	case *ast.DeclStmt:
		return marshal(map[string]interface{}{
			"type": "DeclStmt",
			"line": line,
			"col":  col,
			"decl": marshalDecl(fset, s.Decl),
		})

	case *ast.GoStmt:
		// BANNED: goroutine launch
		return marshal(map[string]interface{}{
			"type": "GoStmt",
			"line": line,
			"col":  col,
		})

	case *ast.SelectStmt:
		// BANNED: select statement
		return marshal(map[string]interface{}{
			"type": "SelectStmt",
			"line": line,
			"col":  col,
		})

	case *ast.DeferStmt:
		// BANNED: defer statement
		return marshal(map[string]interface{}{
			"type": "DeferStmt",
			"line": line,
			"col":  col,
		})

	case *ast.SendStmt:
		// BANNED: channel send
		return marshal(map[string]interface{}{
			"type": "SendStmt",
			"line": line,
			"col":  col,
		})

	case *ast.BlockStmt:
		return marshal(map[string]interface{}{
			"type":   "UnsupportedStmt",
			"line":   line,
			"col":    col,
			"reason": "BlockStmt",
		})

	case *ast.IfStmt:
		return marshal(map[string]interface{}{
			"type":   "UnsupportedStmt",
			"line":   line,
			"col":    col,
			"reason": "IfStmt",
		})

	case *ast.ForStmt:
		return marshal(map[string]interface{}{
			"type":   "UnsupportedStmt",
			"line":   line,
			"col":    col,
			"reason": "ForStmt",
		})

	case *ast.RangeStmt:
		return marshal(map[string]interface{}{
			"type":   "UnsupportedStmt",
			"line":   line,
			"col":    col,
			"reason": "RangeStmt",
		})

	case *ast.SwitchStmt:
		return marshal(map[string]interface{}{
			"type":   "UnsupportedStmt",
			"line":   line,
			"col":    col,
			"reason": "SwitchStmt",
		})

	default:
		return marshal(map[string]interface{}{
			"type":   "UnsupportedStmt",
			"line":   line,
			"col":    col,
			"reason": fmt.Sprintf("%T", stmt),
		})
	}
}

func marshalExpr(fset *token.FileSet, expr ast.Expr) json.RawMessage {
	line, col := position(fset, expr.Pos())

	switch e := expr.(type) {
	case *ast.Ident:
		return marshal(map[string]interface{}{
			"type": "Ident",
			"line": line,
			"col":  col,
			"name": e.Name,
		})

	case *ast.BasicLit:
		return marshal(map[string]interface{}{
			"type":  "BasicLit",
			"line":  line,
			"col":   col,
			"kind":  e.Kind.String(),
			"value": e.Value,
		})

	case *ast.BinaryExpr:
		return marshal(map[string]interface{}{
			"type": "BinaryExpr",
			"line": line,
			"col":  col,
			"op":   e.Op.String(),
			"x":    marshalExpr(fset, e.X),
			"y":    marshalExpr(fset, e.Y),
		})

	case *ast.UnaryExpr:
		if e.Op.String() == "<-" {
			return marshal(map[string]interface{}{
				"type": "ChanRecv",
				"line": line,
				"col":  col,
			})
		}
		return marshal(map[string]interface{}{
			"type": "UnaryExpr",
			"line": line,
			"col":  col,
			"op":   e.Op.String(),
			"x":    marshalExpr(fset, e.X),
		})

	case *ast.CallExpr:
		args := make([]json.RawMessage, len(e.Args))
		for i, a := range e.Args {
			args[i] = marshalExpr(fset, a)
		}
		return marshal(map[string]interface{}{
			"type": "CallExpr",
			"line": line,
			"col":  col,
			"fun":  marshalExpr(fset, e.Fun),
			"args": args,
		})

	case *ast.SelectorExpr:
		return marshal(map[string]interface{}{
			"type": "SelectorExpr",
			"line": line,
			"col":  col,
			"x":    marshalExpr(fset, e.X),
			"sel":  e.Sel.Name,
		})

	case *ast.IndexExpr:
		return marshal(map[string]interface{}{
			"type":  "IndexExpr",
			"line":  line,
			"col":   col,
			"x":     marshalExpr(fset, e.X),
			"index": marshalExpr(fset, e.Index),
		})

	case *ast.ParenExpr:
		return marshalExpr(fset, e.X)

	case *ast.ChanType:
		return marshal(map[string]interface{}{
			"type": "ChanRecv",
			"line": line,
			"col":  col,
		})

	default:
		return marshal(map[string]interface{}{
			"type":   "UnsupportedExpr",
			"line":   line,
			"col":    col,
			"reason": fmt.Sprintf("%T", expr),
		})
	}
}

func marshalDecl(fset *token.FileSet, decl ast.Decl) json.RawMessage {
	switch d := decl.(type) {
	case *ast.GenDecl:
		for _, spec := range d.Specs {
			if vs, ok := spec.(*ast.ValueSpec); ok {
				names := make([]string, len(vs.Names))
				for i, n := range vs.Names {
					names[i] = n.Name
				}
				values := make([]json.RawMessage, len(vs.Values))
				for i, v := range vs.Values {
					values[i] = marshalExpr(fset, v)
				}
				return marshal(map[string]interface{}{
					"type":   "ValueSpec",
					"names":  names,
					"values": values,
				})
			}
		}
	}
	return marshal(map[string]interface{}{
		"type":   "UnsupportedDecl",
		"reason": fmt.Sprintf("%T", decl),
	})
}

func marshal(v interface{}) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("go-ast-parse: marshal: %v", err))
	}
	return b
}

func typeExprToString(fset *token.FileSet, expr ast.Expr) string {
	var buf strings.Builder
	if err := printer.Fprint(&buf, fset, expr); err != nil {
		return fmt.Sprintf("%v", expr)
	}
	return buf.String()
}
