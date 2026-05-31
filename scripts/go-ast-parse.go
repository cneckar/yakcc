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
		// WI-964: emit structured IfStmt node instead of UnsupportedStmt.
		return marshalIfStmt(fset, s, line, col)

	case *ast.ForStmt:
		// WI-964: emit structured ForStmt node.
		return marshalForStmt(fset, s, line, col)

	case *ast.RangeStmt:
		// WI-964: emit structured RangeStmt node.
		return marshalRangeStmt(fset, s, line, col)

	case *ast.SwitchStmt:
		// WI-964: emit structured SwitchStmt node.
		return marshalSwitchStmt(fset, s, line, col)

	case *ast.IncDecStmt:
		// #982: emit IncDecStmt wire node for i++/i-- statements.
		// Only identifier targets are supported in the pure-function subset;
		// non-identifier targets (e.g. arr[i]++ or a.b++) fall through to
		// UnsupportedStmt since they imply mutation of complex lvalue paths.
		target := ""
		if id, ok := s.X.(*ast.Ident); ok {
			target = id.Name
		} else {
			return marshal(map[string]interface{}{
				"type":   "UnsupportedStmt",
				"line":   line,
				"col":    col,
				"reason": fmt.Sprintf("IncDecStmt(non-ident target: %T)", s.X),
			})
		}
		op := "++"
		if s.Tok == token.DEC {
			op = "--"
		}
		return marshal(map[string]interface{}{
			"type":   "IncDecStmt",
			"line":   line,
			"col":    col,
			"target": target,
			"op":     op,
		})

	case *ast.BranchStmt:
		// #1001: BranchStmt covers break, continue, goto, and fallthrough.
		// break and continue have direct TS equivalents and are raised as
		// BranchStmt wire nodes. goto and fallthrough have no TS equivalent;
		// emit UnsupportedStmt so raise-body.ts can throw
		// GoUnsupportedConstructError with a clear message rather than a
		// generic "unsupported" catch.
		tok := s.Tok.String() // "break", "continue", "goto", "fallthrough"
		if tok == "break" || tok == "continue" {
			var label interface{}
			if s.Label != nil {
				label = s.Label.Name
			}
			return marshal(map[string]interface{}{
				"type":  "BranchStmt",
				"line":  line,
				"col":   col,
				"tok":   tok,
				"label": label,
			})
		}
		// goto and fallthrough: not raiseable to TS subset.
		return marshal(map[string]interface{}{
			"type":   "UnsupportedStmt",
			"line":   line,
			"col":    col,
			"reason": fmt.Sprintf("BranchStmt(%s)", tok),
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

	case *ast.SliceExpr:
		// #1000: s[i:j], s[i:], s[:j], s[:] — three-index s[i:j:k] is rejected.
		// Emit SliceExpr wire node with nullable low/high fields.
		if e.Max != nil {
			// Three-index slice (s[i:j:k]) is out of scope for MVP; reject.
			return marshal(map[string]interface{}{
				"type":   "UnsupportedExpr",
				"line":   line,
				"col":    col,
				"reason": "*ast.SliceExpr(3-index)",
			})
		}
		var lowRaw, highRaw json.RawMessage
		if e.Low != nil {
			lowRaw = marshalExpr(fset, e.Low)
		} else {
			lowRaw = marshal(nil)
		}
		if e.High != nil {
			highRaw = marshalExpr(fset, e.High)
		} else {
			highRaw = marshal(nil)
		}
		return marshal(map[string]interface{}{
			"type": "SliceExpr",
			"line": line,
			"col":  col,
			"x":    marshalExpr(fset, e.X),
			"low":  lowRaw,
			"high": highRaw,
		})

	case *ast.ParenExpr:
		return marshalExpr(fset, e.X)

	case *ast.ChanType:
		return marshal(map[string]interface{}{
			"type": "ChanRecv",
			"line": line,
			"col":  col,
		})

	case *ast.CompositeLit:
		// #986: CompositeLit covers slice/map/struct literals.
		// Slice:  []T{a, b, c}  — Type is *ast.ArrayType
		// Map:    map[K]V{k: v} — Type is *ast.MapType
		// Struct: Foo{X: 1}     — deferred; emit UnsupportedExpr for MVP.
		return marshalCompositeLit(fset, e, line, col)

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

// ---------------------------------------------------------------------------
// #986: CompositeLit marshaling (slice and map literals)
// ---------------------------------------------------------------------------

// marshalCompositeLit emits SliceLit or MapLit wire nodes for []T{...} and
// map[K]V{...} expressions.  Struct literals (Ident or SelectorExpr type) are
// deferred for MVP and emitted as UnsupportedExpr so raise-body.ts can throw
// GoUnsupportedConstructError without re-parsing raw source text.
//
// @decision DEC-COMPOSITELIT-WIRE-001 (#986)
// @title Emit distinct SliceLit/MapLit wire nodes; defer StructLit to UnsupportedExpr
// @status accepted (#986)
// @rationale
//   Conflating slice/map/struct literals into a single "CompositeLit" node would
//   force raise-body.ts to re-parse the Go type string to distinguish variants --
//   defeating the structured wire design.  Emitting named variants with decoded
//   type fields keeps raise-body.ts as a pure TS consumer with no Go syntax
//   knowledge.  Struct literals require type resolution to handle field names and
//   are deferred to a later work item.
func marshalCompositeLit(fset *token.FileSet, e *ast.CompositeLit, line, col int) json.RawMessage {
	if e.Type == nil {
		// Untyped composite literal (e.g. struct field shorthand or implicit type).
		// Not in scope for #986 MVP.
		return marshal(map[string]interface{}{
			"type":   "UnsupportedExpr",
			"line":   line,
			"col":    col,
			"reason": "*ast.CompositeLit(untyped)",
		})
	}

	switch t := e.Type.(type) {
	case *ast.ArrayType:
		// []T{a, b, c} -- slice literal (ArrayType with nil Len means slice, not array).
		// Fixed-size arrays (e.g. [3]int{1,2,3}) also match ArrayType; treat as slice
		// for MVP since the pure-function subset rarely uses fixed arrays.
		elementTypeStr := typeExprToString(fset, t.Elt)
		elements := make([]json.RawMessage, len(e.Elts))
		for i, elt := range e.Elts {
			elements[i] = marshalExpr(fset, elt)
		}
		return marshal(map[string]interface{}{
			"type":        "SliceLit",
			"line":        line,
			"col":         col,
			"elementType": elementTypeStr,
			"elements":    elements,
		})

	case *ast.MapType:
		// map[K]V{k: v, ...} -- map literal.
		keyTypeStr := typeExprToString(fset, t.Key)
		valueTypeStr := typeExprToString(fset, t.Value)
		entries := make([]json.RawMessage, 0, len(e.Elts))
		for _, elt := range e.Elts {
			kv, ok := elt.(*ast.KeyValueExpr)
			if !ok {
				// Non-KV element in map literal: should not occur in valid Go.
				return marshal(map[string]interface{}{
					"type":   "UnsupportedExpr",
					"line":   line,
					"col":    col,
					"reason": "*ast.CompositeLit(map-non-kv)",
				})
			}
			entry := marshal(map[string]interface{}{
				"key":   marshalExpr(fset, kv.Key),
				"value": marshalExpr(fset, kv.Value),
			})
			entries = append(entries, entry)
		}
		return marshal(map[string]interface{}{
			"type":      "MapLit",
			"line":      line,
			"col":       col,
			"keyType":   keyTypeStr,
			"valueType": valueTypeStr,
			"entries":   entries,
		})

	default:
		// Struct literal or unknown: deferred for MVP.
		return marshal(map[string]interface{}{
			"type":   "UnsupportedExpr",
			"line":   line,
			"col":    col,
			"reason": fmt.Sprintf("*ast.CompositeLit(%T)", e.Type),
		})
	}
}

// ---------------------------------------------------------------------------
// WI-964: control-flow statement marshalers
// ---------------------------------------------------------------------------

// marshalIfStmt emits an IfStmt wire node.
// The orelse field is:
//   - null           — no else branch
//   - IfStmt object  — else-if chain (the else body is itself an *ast.IfStmt)
//   - BlockNode      — plain else body ({type:"BlockNode", body:GoBodyNode})
func marshalIfStmt(fset *token.FileSet, s *ast.IfStmt, line, col int) json.RawMessage {
	var initRaw json.RawMessage
	if s.Init != nil {
		initRaw = marshalStmt(fset, s.Init)
	} else {
		initRaw = marshal(nil)
	}

	bodyNode := buildBodyNode(fset, s.Body)

	var orelseRaw json.RawMessage
	if s.Else == nil {
		orelseRaw = marshal(nil)
	} else {
		switch el := s.Else.(type) {
		case *ast.IfStmt:
			elLine, elCol := position(fset, el.Pos())
			orelseRaw = marshalIfStmt(fset, el, elLine, elCol)
		case *ast.BlockStmt:
			elseBody := buildBodyNode(fset, el)
			orelseRaw = marshal(map[string]interface{}{
				"type": "BlockNode",
				"body": elseBody,
			})
		default:
			orelseRaw = marshal(nil)
		}
	}

	return marshal(map[string]interface{}{
		"type":   "IfStmt",
		"line":   line,
		"col":    col,
		"init":   initRaw,
		"cond":   marshalExpr(fset, s.Cond),
		"body":   bodyNode,
		"orelse": orelseRaw,
	})
}

// marshalForStmt emits a ForStmt wire node (classic C-style for loop).
func marshalForStmt(fset *token.FileSet, s *ast.ForStmt, line, col int) json.RawMessage {
	var initRaw json.RawMessage
	if s.Init != nil {
		initRaw = marshalStmt(fset, s.Init)
	} else {
		initRaw = marshal(nil)
	}

	var condRaw json.RawMessage
	if s.Cond != nil {
		condRaw = marshalExpr(fset, s.Cond)
	} else {
		condRaw = marshal(nil)
	}

	var postRaw json.RawMessage
	if s.Post != nil {
		postRaw = marshalStmt(fset, s.Post)
	} else {
		postRaw = marshal(nil)
	}

	bodyNode := buildBodyNode(fset, s.Body)

	return marshal(map[string]interface{}{
		"type": "ForStmt",
		"line": line,
		"col":  col,
		"init": initRaw,
		"cond": condRaw,
		"post": postRaw,
		"body": bodyNode,
	})
}

// marshalRangeStmt emits a RangeStmt wire node.
// key/value are the loop variable names; null is emitted for blank identifiers (_).
func marshalRangeStmt(fset *token.FileSet, s *ast.RangeStmt, line, col int) json.RawMessage {
	var keyName interface{}
	if s.Key != nil {
		if id, ok := s.Key.(*ast.Ident); ok && id.Name != "_" {
			keyName = id.Name
		}
	}

	var valueName interface{}
	if s.Value != nil {
		if id, ok := s.Value.(*ast.Ident); ok && id.Name != "_" {
			valueName = id.Name
		}
	}

	bodyNode := buildBodyNode(fset, s.Body)

	return marshal(map[string]interface{}{
		"type":  "RangeStmt",
		"line":  line,
		"col":   col,
		"key":   keyName,
		"value": valueName,
		"tok":   s.Tok.String(),
		"x":     marshalExpr(fset, s.X),
		"body":  bodyNode,
	})
}

// marshalSwitchStmt emits a SwitchStmt wire node.
func marshalSwitchStmt(fset *token.FileSet, s *ast.SwitchStmt, line, col int) json.RawMessage {
	var initRaw json.RawMessage
	if s.Init != nil {
		initRaw = marshalStmt(fset, s.Init)
	} else {
		initRaw = marshal(nil)
	}

	var tagRaw json.RawMessage
	if s.Tag != nil {
		tagRaw = marshalExpr(fset, s.Tag)
	} else {
		tagRaw = marshal(nil)
	}

	cases := []json.RawMessage{}
	for _, stmt := range s.Body.List {
		cc, ok := stmt.(*ast.CaseClause)
		if !ok {
			continue
		}
		caseList := make([]json.RawMessage, len(cc.List))
		for i, e := range cc.List {
			caseList[i] = marshalExpr(fset, e)
		}
		// Build the case body: wrap the list of statements in a GoBodyNode.
		caseBody := GoBodyNode{Stmts: []json.RawMessage{}}
		for _, bodyStmt := range cc.Body {
			caseBody.Stmts = append(caseBody.Stmts, marshalStmt(fset, bodyStmt))
		}
		cases = append(cases, marshal(map[string]interface{}{
			"type": "CaseClause",
			"list": caseList,
			"body": caseBody,
		}))
	}

	return marshal(map[string]interface{}{
		"type":  "SwitchStmt",
		"line":  line,
		"col":   col,
		"init":  initRaw,
		"tag":   tagRaw,
		"cases": cases,
	})
}
