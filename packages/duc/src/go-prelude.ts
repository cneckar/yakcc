// SPDX-License-Identifier: Apache-2.0
/**
 * JavaScript's meaning in Go (#1278): the runtime every Go lowering of a graph starts with. Values
 * are dynamic (`any`): a number is float64 (JavaScript's numbers are doubles, so this is exact), a
 * string is string, a boolean is bool, null is nil, undefined is `Undefined`, an array is `*Array`
 * and an object is `*Object` (both references, as in JavaScript, so a write is seen by every holder;
 * an object keeps its keys in insertion order). A throw is a panic of `*JsThrow`.
 */
export const GO_PRELUDE = `package main

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type undefinedT struct{}

var Undefined any = undefinedT{}

type Array struct{ Items []any }

type Object struct {
	Keys []string
	Vals map[string]any
}

type JsThrow struct{ Value any }

type JsError struct {
	Kind    string
	Message string
}

func NewObject() *Object { return &Object{Vals: map[string]any{}} }

func (o *Object) Set(k string, v any) {
	if _, ok := o.Vals[k]; !ok {
		o.Keys = append(o.Keys, k)
	}
	o.Vals[k] = v
}

func throw(v any) any { panic(&JsThrow{v}) }

func newError(kind string, msg any) any {
	m := ""
	if msg != Undefined {
		m = str(msg)
	}
	return &JsError{Kind: kind, Message: m}
}

type objSpread struct{ o any }

// obj builds an object from key/value pairs; a spread part merges another object's fields.
func obj(parts ...any) any {
	o := NewObject()
	for i := 0; i < len(parts); i++ {
		if sp, ok := parts[i].(objSpread); ok {
			if src, ok := sp.o.(*Object); ok {
				for _, k := range src.Keys {
					o.Set(k, src.Vals[k])
				}
			}
			continue
		}
		o.Set(parts[i].(string), parts[i+1])
		i++
	}
	return o
}

func sel(c bool, a, b any) any {
	if c {
		return a
	}
	return b
}

func and(a, b any) any { return sel(truthy(a), b, a) }
func or(a, b any) any  { return sel(truthy(a), a, b) }
func nullish(a, b any) any {
	if a == nil || a == Undefined {
		return b
	}
	return a
}
func isNullish(a any) bool { return a == nil || a == Undefined }

func lazyAnd(a any, b func() any) any {
	if truthy(a) {
		return b()
	}
	return a
}
func lazyOr(a any, b func() any) any {
	if truthy(a) {
		return a
	}
	return b()
}
func lazySel(c any, a, b func() any) any {
	if truthy(c) {
		return a()
	}
	return b()
}

func isNum(x any) bool { _, ok := x.(float64); return ok }

func truthy(x any) bool {
	switch v := x.(type) {
	case nil:
		return false
	case undefinedT:
		return false
	case bool:
		return v
	case float64:
		return v != 0 && !math.IsNaN(v)
	case string:
		return v != ""
	}
	return true
}

func num(x any) float64 {
	switch v := x.(type) {
	case float64:
		return v
	case bool:
		if v {
			return 1
		}
		return 0
	case nil:
		return 0
	case string:
		s := strings.TrimSpace(v)
		if s == "" {
			return 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

func numStr(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	if math.IsInf(f, 1) {
		return "Infinity"
	}
	if math.IsInf(f, -1) {
		return "-Infinity"
	}
	if f == 0 {
		return "0"
	}
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return strconv.FormatFloat(f, 'g', -1, 64)
}

func str(x any) string {
	switch v := x.(type) {
	case string:
		return v
	case nil:
		return "null"
	case undefinedT:
		return "undefined"
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		return numStr(v)
	case *Array:
		parts := make([]string, len(v.Items))
		for i, e := range v.Items {
			if e == nil || e == Undefined {
				parts[i] = ""
			} else {
				parts[i] = str(e)
			}
		}
		return strings.Join(parts, ",")
	case *JsError:
		return v.Kind + ": " + v.Message
	}
	return "[object Object]"
}

func add(a, b any) any {
	_, as := a.(string)
	_, bs := b.(string)
	_, aa := a.(*Array)
	_, ba := b.(*Array)
	_, ao := a.(*Object)
	_, bo := b.(*Object)
	if as || bs || aa || ba || ao || bo {
		return str(a) + str(b)
	}
	return num(a) + num(b)
}

func sub(a, b any) any { return num(a) - num(b) }
func mul(a, b any) any { return num(a) * num(b) }
func div(a, b any) any { return num(a) / num(b) }
func rem(a, b any) any { return math.Mod(num(a), num(b)) }
func pow(a, b any) any { return math.Pow(num(a), num(b)) }
func neg(a any) any    { return -num(a) }

func lt(a, b any) bool {
	if as, ok := a.(string); ok {
		if bs, ok := b.(string); ok {
			return as < bs
		}
	}
	return num(a) < num(b)
}
func gt(a, b any) bool { return lt(b, a) }
func le(a, b any) bool {
	if as, ok := a.(string); ok {
		if bs, ok := b.(string); ok {
			return as <= bs
		}
	}
	x, y := num(a), num(b)
	return x <= y
}
func ge(a, b any) bool { return le(b, a) }

func seq(a, b any) bool {
	switch x := a.(type) {
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case nil:
		return b == nil
	case undefinedT:
		return b == Undefined
	}
	return a == b
}

func typeOf(x any) string {
	switch x.(type) {
	case undefinedT:
		return "undefined"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case func(...any) any:
		return "function"
	}
	return "object"
}

func get(o any, k string) any {
	switch v := o.(type) {
	case *Object:
		if x, ok := v.Vals[k]; ok {
			return x
		}
		return Undefined
	case *Array:
		if k == "length" {
			return float64(len(v.Items))
		}
	case string:
		if k == "length" {
			return float64(len([]rune(v)))
		}
	case *JsError:
		if k == "message" {
			return v.Message
		}
		if k == "name" {
			return v.Kind
		}
	case nil, undefinedT:
		return throw(&JsError{"TypeError", "Cannot read properties of " + str(o) + " (reading '" + k + "')"})
	}
	return Undefined
}

func idx(o any, i any) any {
	switch v := o.(type) {
	case *Array:
		f := num(i)
		if f == math.Trunc(f) && f >= 0 && int(f) < len(v.Items) {
			return v.Items[int(f)]
		}
		return Undefined
	case string:
		r := []rune(v)
		f := num(i)
		if f == math.Trunc(f) && f >= 0 && int(f) < len(r) {
			return string(r[int(f)])
		}
		return Undefined
	case *Object:
		return get(v, str(i))
	case nil, undefinedT:
		return throw(&JsError{"TypeError", "Cannot read properties of " + str(o)})
	}
	return Undefined
}

func put(o any, k any, v any) any {
	switch x := o.(type) {
	case *Object:
		x.Set(str(k), v)
	case *Array:
		f := num(k)
		for int(f) >= len(x.Items) {
			x.Items = append(x.Items, Undefined)
		}
		x.Items[int(f)] = v
	}
	return o
}

func values(o any) []any {
	switch v := o.(type) {
	case *Array:
		return append([]any{}, v.Items...)
	case string:
		out := []any{}
		for _, r := range v {
			out = append(out, string(r))
		}
		return out
	}
	return throw(&JsError{"TypeError", str(o) + " is not iterable"}).([]any)
}

func keys(o any) []any {
	switch v := o.(type) {
	case *Object:
		out := []any{}
		for _, k := range v.Keys {
			out = append(out, k)
		}
		return out
	case *Array:
		out := []any{}
		for i := range v.Items {
			out = append(out, strconv.Itoa(i))
		}
		return out
	}
	return []any{}
}

func arr(items ...any) any { return &Array{Items: items} }

func spread(parts ...[]any) any {
	out := []any{}
	for _, p := range parts {
		out = append(out, p...)
	}
	return &Array{Items: out}
}

func call(f any, args ...any) any {
	fn, ok := f.(func(...any) any)
	if !ok {
		return throw(&JsError{"TypeError", str(f) + " is not a function"})
	}
	return fn(args...)
}

func arg(args []any, i int) any {
	if i < len(args) {
		return args[i]
	}
	return Undefined
}

func round(x any) any { return math.Floor(num(x) + 0.5) }

func mathMax(xs ...any) any {
	m := math.Inf(-1)
	for _, x := range xs {
		f := num(x)
		if math.IsNaN(f) {
			return math.NaN()
		}
		m = math.Max(m, f)
	}
	return m
}

func mathMin(xs ...any) any {
	m := math.Inf(1)
	for _, x := range xs {
		f := num(x)
		if math.IsNaN(f) {
			return math.NaN()
		}
		m = math.Min(m, f)
	}
	return m
}

func strMethod(s any) string {
	v, ok := s.(string)
	if !ok {
		return str(s)
	}
	return v
}

func indexOf(s any, x any) any {
	if v, ok := s.(string); ok {
		i := strings.Index(v, str(x))
		if i < 0 {
			return float64(-1)
		}
		return float64(len([]rune(v[:i])))
	}
	if a, ok := s.(*Array); ok {
		for i, e := range a.Items {
			if seq(e, x) {
				return float64(i)
			}
		}
	}
	return float64(-1)
}

func includes(s any, x any) any {
	if v, ok := s.(string); ok {
		return strings.Contains(v, str(x))
	}
	if a, ok := s.(*Array); ok {
		for _, e := range a.Items {
			if seq(e, x) {
				return true
			}
		}
	}
	return false
}

func clampIndex(x any, n int, d int) int {
	if x == Undefined {
		return d
	}
	f := num(x)
	if math.IsNaN(f) {
		return 0
	}
	i := int(math.Trunc(f))
	if i < 0 {
		i += n
		if i < 0 {
			i = 0
		}
	}
	if i > n {
		i = n
	}
	return i
}

func slice(s any, a any, b any) any {
	if v, ok := s.(string); ok {
		r := []rune(v)
		i, j := clampIndex(a, len(r), 0), clampIndex(b, len(r), len(r))
		if i >= j {
			return ""
		}
		return string(r[i:j])
	}
	if v, ok := s.(*Array); ok {
		i, j := clampIndex(a, len(v.Items), 0), clampIndex(b, len(v.Items), len(v.Items))
		if i >= j {
			return &Array{}
		}
		return &Array{Items: append([]any{}, v.Items[i:j]...)}
	}
	return Undefined
}

func split(s any, sep any) any {
	v := strMethod(s)
	if sep == Undefined {
		return arr(v)
	}
	var parts []string
	if str(sep) == "" {
		for _, r := range v {
			parts = append(parts, string(r))
		}
	} else {
		parts = strings.Split(v, str(sep))
	}
	out := make([]any, len(parts))
	for i, p := range parts {
		out[i] = p
	}
	return &Array{Items: out}
}

func join(xs any, sep any) any {
	s := ","
	if sep != Undefined {
		s = str(sep)
	}
	a, _ := xs.(*Array)
	parts := []string{}
	if a != nil {
		for _, e := range a.Items {
			if e == nil || e == Undefined {
				parts = append(parts, "")
			} else {
				parts = append(parts, str(e))
			}
		}
	}
	return strings.Join(parts, s)
}

func push(xs any, items ...any) any {
	a := xs.(*Array)
	a.Items = append(a.Items, items...)
	return float64(len(a.Items))
}

func mapArr(xs any, f any) any {
	a := xs.(*Array)
	items := append([]any{}, a.Items...)
	out := make([]any, len(items))
	for i, e := range items {
		out[i] = call(f, e, float64(i), xs)
	}
	return &Array{Items: out}
}

func filterArr(xs any, f any) any {
	a := xs.(*Array)
	out := []any{}
	for i, e := range append([]any{}, a.Items...) {
		if truthy(call(f, e, float64(i), xs)) {
			out = append(out, e)
		}
	}
	return &Array{Items: out}
}

func reduceArr(xs any, f any, init ...any) any {
	items := append([]any{}, xs.(*Array).Items...)
	start := 0
	var acc any
	if len(init) > 0 {
		acc = init[0]
	} else {
		if len(items) == 0 {
			return throw(&JsError{"TypeError", "Reduce of empty array with no initial value"})
		}
		acc, start = items[0], 1
	}
	for i := start; i < len(items); i++ {
		acc = call(f, acc, items[i], float64(i), xs)
	}
	return acc
}

func someArr(xs any, f any) any {
	for i, e := range append([]any{}, xs.(*Array).Items...) {
		if truthy(call(f, e, float64(i), xs)) {
			return true
		}
	}
	return false
}

func everyArr(xs any, f any) any {
	for i, e := range append([]any{}, xs.(*Array).Items...) {
		if !truthy(call(f, e, float64(i), xs)) {
			return false
		}
	}
	return true
}

func parseInt(s any, radix any) any {
	t := strings.TrimSpace(str(s))
	base := 10
	if radix != Undefined && num(radix) != 0 {
		base = int(num(radix))
	}
	sign := 1.0
	if strings.HasPrefix(t, "-") {
		sign, t = -1, t[1:]
	} else if strings.HasPrefix(t, "+") {
		t = t[1:]
	}
	if base == 16 && (strings.HasPrefix(t, "0x") || strings.HasPrefix(t, "0X")) {
		t = t[2:]
	}
	if base < 2 || base > 36 {
		return math.NaN()
	}
	end := 0
	for end < len(t) {
		c := t[end]
		var d int
		switch {
		case c >= '0' && c <= '9':
			d = int(c - '0')
		case c >= 'a' && c <= 'z':
			d = int(c-'a') + 10
		case c >= 'A' && c <= 'Z':
			d = int(c-'A') + 10
		default:
			d = 99
		}
		if d >= base {
			break
		}
		end++
	}
	if end == 0 {
		return math.NaN()
	}
	v, err := strconv.ParseInt(t[:end], base, 64)
	if err != nil {
		return math.NaN()
	}
	return sign * float64(v)
}

type RegExp struct {
	Re     *regexp.Regexp
	Global bool
}

var regexCache = map[string]*RegExp{}

func re(pattern string, global bool) any {
	key := pattern
	if global {
		key += "/g"
	}
	if r, ok := regexCache[key]; ok {
		return r
	}
	r := &RegExp{Re: regexp.MustCompile(pattern), Global: global}
	regexCache[key] = r
	return r
}

func reTest(r any, s any) any { return r.(*RegExp).Re.MatchString(str(s)) }

// expandReplacement applies JavaScript's replacement patterns ($$, $&, $\`, $', $n and $nn) to one match.
func expandReplacement(rep string, v string, loc []int) string {
	var b strings.Builder
	groups := len(loc)/2 - 1
	for i := 0; i < len(rep); i++ {
		c := rep[i]
		if c != '$' || i+1 >= len(rep) {
			b.WriteByte(c)
			continue
		}
		n := rep[i+1]
		switch {
		case n == '$':
			b.WriteByte('$')
			i++
		case n == '&':
			b.WriteString(v[loc[0]:loc[1]])
			i++
		case n == '\`':
			b.WriteString(v[:loc[0]])
			i++
		case n == '\\'':
			b.WriteString(v[loc[1]:])
			i++
		case n >= '0' && n <= '9':
			k := int(n - '0')
			used := 1
			if i+2 < len(rep) && rep[i+2] >= '0' && rep[i+2] <= '9' {
				if kk := k*10 + int(rep[i+2]-'0'); kk >= 1 && kk <= groups {
					k = kk
					used = 2
				}
			}
			if k < 1 || k > groups {
				b.WriteByte(c)
				continue
			}
			if loc[2*k] >= 0 {
				b.WriteString(v[loc[2*k]:loc[2*k+1]])
			}
			i += used
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

func replace(s any, pattern any, rep any) any {
	v := strMethod(s)
	t := str(rep)
	if r, ok := pattern.(*RegExp); ok {
		var locs [][]int
		if r.Global {
			locs = r.Re.FindAllStringSubmatchIndex(v, -1)
		} else if loc := r.Re.FindStringSubmatchIndex(v); loc != nil {
			locs = [][]int{loc}
		}
		var b strings.Builder
		last := 0
		for _, loc := range locs {
			b.WriteString(v[last:loc[0]])
			b.WriteString(expandReplacement(t, v, loc))
			last = loc[1]
		}
		b.WriteString(v[last:])
		return b.String()
	}
	p := str(pattern)
	i := strings.Index(v, p)
	if i < 0 {
		return v
	}
	return v[:i] + expandReplacement(t, v, []int{i, i + len(p)}) + v[i+len(p):]
}

func concat(s any, parts ...any) any {
	out := strMethod(s)
	for _, p := range parts {
		out += str(p)
	}
	return out
}

func substring(s any, a any, b any) any {
	r := []rune(strMethod(s))
	n := len(r)
	clamp := func(x any, d int) int {
		if x == Undefined {
			return d
		}
		f := num(x)
		if math.IsNaN(f) || f < 0 {
			return 0
		}
		if int(f) > n {
			return n
		}
		return int(f)
	}
	i, j := clamp(a, 0), clamp(b, n)
	if i > j {
		i, j = j, i
	}
	return string(r[i:j])
}

func forEachArr(xs any, f any) any {
	for i, e := range append([]any{}, xs.(*Array).Items...) {
		call(f, e, float64(i), xs)
	}
	return Undefined
}

func findArr(xs any, f any) any {
	for i, e := range append([]any{}, xs.(*Array).Items...) {
		if truthy(call(f, e, float64(i), xs)) {
			return e
		}
	}
	return Undefined
}

func findIndexArr(xs any, f any) any {
	for i, e := range append([]any{}, xs.(*Array).Items...) {
		if truthy(call(f, e, float64(i), xs)) {
			return float64(i)
		}
	}
	return float64(-1)
}

// Platform functions as values, called back as JavaScript calls them (extra arguments ignored).
var fnParseInt any = func(a ...any) any { return parseInt(arg(a, 0), arg(a, 1)) }
var fnString any = func(a ...any) any {
	if len(a) == 0 {
		return ""
	}
	return str(a[0])
}
var fnNumber any = func(a ...any) any {
	if len(a) == 0 {
		return float64(0)
	}
	return num(a[0])
}
var fnBoolean any = func(a ...any) any { return truthy(arg(a, 0)) }

func hasKey(k any, o any) any {
	key := str(k)
	switch v := o.(type) {
	case *Object:
		_, ok := v.Vals[key]
		return ok
	case *Array:
		if key == "length" {
			return true
		}
		i, err := strconv.Atoi(key)
		return err == nil && i >= 0 && i < len(v.Items) && strconv.Itoa(i) == key
	}
	return throw(&JsError{"TypeError", "Cannot use 'in' operator to search for '" + key + "' in " + str(o)})
}

func isArray(x any) any {
	_, ok := x.(*Array)
	return ok
}

func charAt(s any, i any) any {
	r := []rune(strMethod(s))
	k := 0
	if i != Undefined {
		f := math.Trunc(num(i))
		if math.IsNaN(f) {
			f = 0
		}
		if f < 0 || f >= float64(len(r)) {
			return ""
		}
		k = int(f)
	}
	if k >= len(r) {
		return ""
	}
	return string(r[k])
}

func charCodeAt(s any, i any) any {
	c := charAt(s, i).(string)
	if c == "" {
		return math.NaN()
	}
	return float64([]rune(c)[0])
}

func at(s any, i any) any {
	if v, ok := s.(string); ok {
		r := []rune(v)
		k := int(math.Trunc(num(i)))
		if k < 0 {
			k += len(r)
		}
		if k < 0 || k >= len(r) {
			return Undefined
		}
		return string(r[k])
	}
	a := s.(*Array)
	k := int(math.Trunc(num(i)))
	if k < 0 {
		k += len(a.Items)
	}
	if k < 0 || k >= len(a.Items) {
		return Undefined
	}
	return a.Items[k]
}

func match(s any, r any) any {
	v := str(s)
	re, ok := r.(*RegExp)
	if !ok {
		re = &RegExp{Re: regexp.MustCompile(regexp.QuoteMeta(str(r)))}
	}
	if re.Global {
		all := re.Re.FindAllString(v, -1)
		if all == nil {
			return nil
		}
		out := &Array{}
		for _, m := range all {
			out.Items = append(out.Items, m)
		}
		return out
	}
	loc := re.Re.FindStringSubmatchIndex(v)
	if loc == nil {
		return nil
	}
	out := &Array{}
	for g := 0; g < len(loc)/2; g++ {
		if loc[2*g] < 0 {
			out.Items = append(out.Items, Undefined)
		} else {
			out.Items = append(out.Items, v[loc[2*g]:loc[2*g+1]])
		}
	}
	return out
}

func pop(a any) any {
	v := a.(*Array)
	if len(v.Items) == 0 {
		return Undefined
	}
	x := v.Items[len(v.Items)-1]
	v.Items = v.Items[:len(v.Items)-1]
	return x
}

func shift(a any) any {
	v := a.(*Array)
	if len(v.Items) == 0 {
		return Undefined
	}
	x := v.Items[0]
	v.Items = v.Items[1:]
	return x
}

func reverse(a any) any {
	v := a.(*Array)
	for i, j := 0, len(v.Items)-1; i < j; i, j = i+1, j-1 {
		v.Items[i], v.Items[j] = v.Items[j], v.Items[i]
	}
	return a
}

// toInt32 and toUint32 are JavaScript's ToInt32 and ToUint32.
func toUint32(x any) uint32 {
	f := num(x)
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	f = math.Mod(math.Trunc(f), 4294967296)
	if f < 0 {
		f += 4294967296
	}
	return uint32(f)
}

func toInt32(x any) int32 { return int32(toUint32(x)) }

func band(a any, b any) any { return float64(toInt32(a) & toInt32(b)) }
func bor(a any, b any) any  { return float64(toInt32(a) | toInt32(b)) }
func bxor(a any, b any) any { return float64(toInt32(a) ^ toInt32(b)) }
func shl(a any, b any) any  { return float64(toInt32(a) << (toUint32(b) & 31)) }
func shr(a any, b any) any  { return float64(toInt32(a) >> (toUint32(b) & 31)) }
func ushr(a any, b any) any { return float64(toUint32(a) >> (toUint32(b) & 31)) }
func bnot(a any) any        { return float64(^toInt32(a)) }

func isFiniteNumber(x any) any {
	f, ok := x.(float64)
	return ok && !math.IsNaN(f) && !math.IsInf(f, 0)
}

func isIntegerNumber(x any) any {
	f, ok := x.(float64)
	return ok && !math.IsNaN(f) && !math.IsInf(f, 0) && f == math.Trunc(f)
}

// tryCatch is a try statement as the lifter writes it (#1276): the handler gets what the body threw.
func tryCatch(body any, handler any) (out any) {
	defer func() {
		if r := recover(); r != nil {
			t, ok := r.(*JsThrow)
			if !ok {
				panic(r)
			}
			out = call(handler, t.Value)
		}
	}()
	return call(body)
}

var _ = sort.Strings
`;
