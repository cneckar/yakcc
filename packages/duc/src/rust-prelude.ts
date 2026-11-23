// SPDX-License-Identifier: Apache-2.0
/**
 * The Rust runtime a lowered graph runs on (#1278): JavaScript's meaning for the graph's operations,
 * as GO_PRELUDE gives it in Go. Every value is a `V`; arrays and objects are shared (`Rc<RefCell>`)
 * as JavaScript's are; a function is `V::Fun`. A throw unwinds with its value kept aside (no panic
 * message), and `try` catches it with `catch_unwind`. Standard library only.
 */
export const RUST_PRELUDE = String.raw`#![allow(unused, non_snake_case, unused_mut, unreachable_code, unused_variables, dead_code, unused_parens, unused_braces)]
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

#[derive(Clone)]
pub enum V {
    Undef,
    Null,
    Bool(bool),
    Num(f64),
    Str(Rc<str>),
    Arr(Rc<RefCell<Vec<V>>>),
    Obj(Rc<RefCell<Obj>>),
    Fun(Rc<dyn Fn(Vec<V>) -> V>),
    Err(Rc<JsErr>),
    Re(Rc<Re>),
}

pub struct Obj {
    pub keys: Vec<String>,
    pub vals: HashMap<String, V>,
}

impl Obj {
    pub fn set(&mut self, k: String, v: V) {
        if !self.vals.contains_key(&k) {
            self.keys.push(k.clone());
        }
        self.vals.insert(k, v);
    }
}

pub struct JsErr {
    pub kind: String,
    pub message: String,
}

pub struct JsThrow;

thread_local! {
    static THROWN: RefCell<Option<V>> = RefCell::new(None);
}

pub fn throw(v: V) -> ! {
    THROWN.with(|t| *t.borrow_mut() = Some(v));
    std::panic::resume_unwind(Box::new(JsThrow))
}

pub fn take_thrown(payload: Box<dyn std::any::Any + Send>) -> V {
    if payload.is::<JsThrow>() {
        return THROWN.with(|t| t.borrow_mut().take()).unwrap_or(V::Undef);
    }
    std::panic::resume_unwind(payload)
}

pub fn type_error(msg: String) -> ! {
    throw(V::Err(Rc::new(JsErr { kind: "TypeError".to_string(), message: msg })))
}

pub fn new_error(kind: &str, msg: V) -> V {
    let m = match msg {
        V::Undef => String::new(),
        other => str_of(&other),
    };
    V::Err(Rc::new(JsErr { kind: kind.to_string(), message: m }))
}

pub fn s(x: &str) -> V {
    V::Str(Rc::from(x))
}

pub fn n(x: f64) -> V {
    V::Num(x)
}

pub fn b(x: bool) -> V {
    V::Bool(x)
}

pub fn arr(items: Vec<V>) -> V {
    V::Arr(Rc::new(RefCell::new(items)))
}

pub fn fun(f: impl Fn(Vec<V>) -> V + 'static) -> V {
    V::Fun(Rc::new(f))
}

pub enum Entry {
    Key(String, V),
    Spread(V),
}

pub fn obj(entries: Vec<Entry>) -> V {
    let mut o = Obj { keys: Vec::new(), vals: HashMap::new() };
    for e in entries {
        match e {
            Entry::Key(k, v) => o.set(k, v),
            Entry::Spread(x) => match &x {
                V::Obj(src) => {
                    let src = src.borrow();
                    for k in &src.keys {
                        o.set(k.clone(), src.vals[k].clone());
                    }
                }
                V::Arr(a) => {
                    for (i, v) in a.borrow().iter().enumerate() {
                        o.set(i.to_string(), v.clone());
                    }
                }
                V::Str(t) => {
                    for (i, c) in t.chars().enumerate() {
                        o.set(i.to_string(), s(&c.to_string()));
                    }
                }
                _ => {}
            },
        }
    }
    V::Obj(Rc::new(RefCell::new(o)))
}

pub fn truthy(x: &V) -> bool {
    match x {
        V::Undef | V::Null => false,
        V::Bool(v) => *v,
        V::Num(f) => *f != 0.0 && !f.is_nan(),
        V::Str(t) => !t.is_empty(),
        _ => true,
    }
}

pub fn sel(c: bool, a: V, b: V) -> V {
    if c { a } else { b }
}

pub fn and(a: V, b: V) -> V {
    if truthy(&a) { b } else { a }
}

pub fn or(a: V, b: V) -> V {
    if truthy(&a) { a } else { b }
}

pub fn is_nullish(x: &V) -> bool {
    matches!(x, V::Undef | V::Null)
}

pub fn nullish(a: V, b: V) -> V {
    if is_nullish(&a) { b } else { a }
}

pub fn lazy_and(a: V, b: impl FnOnce() -> V) -> V {
    if truthy(&a) { b() } else { a }
}

pub fn lazy_or(a: V, b: impl FnOnce() -> V) -> V {
    if truthy(&a) { a } else { b() }
}

pub fn lazy_sel(c: V, a: impl FnOnce() -> V, b: impl FnOnce() -> V) -> V {
    if truthy(&c) { a() } else { b() }
}

pub fn num(x: &V) -> f64 {
    match x {
        V::Num(f) => *f,
        V::Bool(v) => if *v { 1.0 } else { 0.0 },
        V::Null => 0.0,
        V::Str(t) => {
            let t = t.trim();
            if t.is_empty() {
                return 0.0;
            }
            if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
                return i64::from_str_radix(h, 16).map(|v| v as f64).unwrap_or(f64::NAN);
            }
            match t {
                "Infinity" | "+Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                _ => {
                    if t.chars().all(|c| c.is_ascii_digit() || "+-.eE".contains(c)) {
                        t.parse::<f64>().unwrap_or(f64::NAN)
                    } else {
                        f64::NAN
                    }
                }
            }
        }
        V::Arr(a) => {
            let a = a.borrow();
            match a.len() {
                0 => 0.0,
                1 => num(&s(&str_of(&a[0]))),
                _ => f64::NAN,
            }
        }
        _ => f64::NAN,
    }
}

pub fn num_str(f: f64) -> String {
    if f.is_nan() {
        return "NaN".to_string();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() };
    }
    if f == 0.0 {
        return "0".to_string();
    }
    let a = f.abs();
    if a >= 1e21 || a < 1e-6 {
        let e = format!("{:e}", f);
        // JavaScript writes a positive exponent with its sign.
        return match e.find('e') {
            Some(i) if !e[i + 1..].starts_with('-') => format!("{}e+{}", &e[..i], &e[i + 1..]),
            _ => e,
        };
    }
    format!("{}", f)
}

pub fn str_of(x: &V) -> String {
    match x {
        V::Str(t) => t.to_string(),
        V::Null => "null".to_string(),
        V::Undef => "undefined".to_string(),
        V::Bool(v) => if *v { "true".to_string() } else { "false".to_string() },
        V::Num(f) => num_str(*f),
        V::Arr(a) => a
            .borrow()
            .iter()
            .map(|e| if is_nullish(e) { String::new() } else { str_of(e) })
            .collect::<Vec<_>>()
            .join(","),
        V::Err(e) => if e.message.is_empty() { e.kind.clone() } else { format!("{}: {}", e.kind, e.message) },
        V::Fun(_) => "function () { [native code] }".to_string(),
        V::Re(r) => format!("/{}/{}", r.source, r.flags),
        V::Obj(_) => "[object Object]".to_string(),
    }
}

pub fn str_v(x: V) -> V {
    match x {
        V::Str(_) => x,
        other => s(&str_of(&other)),
    }
}

pub fn add(a: V, b: V) -> V {
    let stringy = |x: &V| matches!(x, V::Str(_) | V::Arr(_) | V::Obj(_) | V::Err(_) | V::Fun(_));
    if stringy(&a) || stringy(&b) {
        return s(&(str_of(&a) + &str_of(&b)));
    }
    n(num(&a) + num(&b))
}

pub fn sub(a: V, b: V) -> V { n(num(&a) - num(&b)) }
pub fn mul(a: V, b: V) -> V { n(num(&a) * num(&b)) }
pub fn div(a: V, b: V) -> V { n(num(&a) / num(&b)) }

pub fn rem(a: V, b: V) -> V {
    let (x, y) = (num(&a), num(&b));
    if y == 0.0 || x.is_infinite() || x.is_nan() || y.is_nan() {
        return n(f64::NAN);
    }
    if y.is_infinite() {
        return n(x);
    }
    n(x % y)
}

pub fn pow(a: V, b: V) -> V {
    let (x, y) = (num(&a), num(&b));
    if y.is_nan() || ((x == 1.0 || x == -1.0) && y.is_infinite()) {
        return n(f64::NAN);
    }
    n(x.powf(y))
}

pub fn neg(a: V) -> V { n(-num(&a)) }

fn compare(a: &V, b: &V) -> Option<std::cmp::Ordering> {
    if let (V::Str(x), V::Str(y)) = (a, b) {
        let xs: Vec<u16> = x.encode_utf16().collect();
        let ys: Vec<u16> = y.encode_utf16().collect();
        return Some(xs.cmp(&ys));
    }
    let pa = match a { V::Arr(_) | V::Obj(_) => s(&str_of(a)), _ => a.clone() };
    let pb = match b { V::Arr(_) | V::Obj(_) => s(&str_of(b)), _ => b.clone() };
    if let (V::Str(_), V::Str(_)) = (&pa, &pb) {
        return compare(&pa, &pb);
    }
    num(&pa).partial_cmp(&num(&pb))
}

pub fn lt(a: V, b: V) -> V { B(compare(&a, &b) == Some(std::cmp::Ordering::Less)) }
pub fn gt(a: V, b: V) -> V { B(compare(&a, &b) == Some(std::cmp::Ordering::Greater)) }
pub fn le(a: V, b: V) -> V { B(matches!(compare(&a, &b), Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal))) }
pub fn ge(a: V, b: V) -> V { B(matches!(compare(&a, &b), Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal))) }

#[allow(non_snake_case)]
pub fn B(x: bool) -> V { V::Bool(x) }

pub fn seq_b(a: &V, b: &V) -> bool {
    match (a, b) {
        (V::Num(x), V::Num(y)) => x == y,
        (V::Str(x), V::Str(y)) => x == y,
        (V::Bool(x), V::Bool(y)) => x == y,
        (V::Null, V::Null) | (V::Undef, V::Undef) => true,
        (V::Arr(x), V::Arr(y)) => Rc::ptr_eq(x, y),
        (V::Obj(x), V::Obj(y)) => Rc::ptr_eq(x, y),
        (V::Fun(x), V::Fun(y)) => Rc::ptr_eq(x, y),
        (V::Err(x), V::Err(y)) => Rc::ptr_eq(x, y),
        (V::Re(x), V::Re(y)) => Rc::ptr_eq(x, y),
        _ => false,
    }
}

pub fn seq(a: V, b: V) -> V { B(seq_b(&a, &b)) }
pub fn sne(a: V, b: V) -> V { B(!seq_b(&a, &b)) }
pub fn not(a: V) -> V { B(!truthy(&a)) }
pub fn pos(a: V) -> V { n(num(&a)) }

pub fn type_of(x: V) -> V {
    s(match x {
        V::Undef => "undefined",
        V::Bool(_) => "boolean",
        V::Num(_) => "number",
        V::Str(_) => "string",
        V::Fun(_) => "function",
        _ => "object",
    })
}

pub fn char_len(t: &str) -> usize {
    t.chars().count()
}

pub fn get(o: V, k: &str) -> V {
    match &o {
        V::Obj(v) => v.borrow().vals.get(k).cloned().unwrap_or(V::Undef),
        V::Arr(a) => {
            if k == "length" {
                return n(a.borrow().len() as f64);
            }
            match k.parse::<usize>() {
                Ok(i) if i.to_string() == k => a.borrow().get(i).cloned().unwrap_or(V::Undef),
                _ => V::Undef,
            }
        }
        V::Str(t) => {
            if k == "length" {
                return n(char_len(t) as f64);
            }
            V::Undef
        }
        V::Err(e) => match k {
            "message" => s(&e.message),
            "name" => s(&e.kind),
            _ => V::Undef,
        },
        V::Null | V::Undef => type_error(format!("Cannot read properties of {} (reading '{}')", str_of(&o), k)),
        _ => V::Undef,
    }
}

pub fn idx(o: V, i: V) -> V {
    match &o {
        V::Arr(a) => {
            let f = num(&i);
            if f == f.trunc() && f >= 0.0 && (f as usize) < a.borrow().len() {
                return a.borrow()[f as usize].clone();
            }
            if let V::Str(k) = &i {
                return get(o.clone(), k);
            }
            V::Undef
        }
        V::Str(t) => {
            let f = num(&i);
            if f == f.trunc() && f >= 0.0 {
                if let Some(c) = t.chars().nth(f as usize) {
                    return s(&c.to_string());
                }
            }
            if let V::Str(k) = &i {
                return get(o.clone(), k);
            }
            V::Undef
        }
        V::Null | V::Undef => type_error(format!("Cannot read properties of {} (reading '{}')", str_of(&o), str_of(&i))),
        _ => get(o.clone(), &str_of(&i)),
    }
}

pub fn put(o: V, k: V, v: V) -> V {
    match &o {
        V::Obj(x) => x.borrow_mut().set(str_of(&k), v),
        V::Arr(x) => {
            let f = num(&k);
            if f == f.trunc() && f >= 0.0 {
                let i = f as usize;
                let mut items = x.borrow_mut();
                while items.len() <= i {
                    items.push(V::Undef);
                }
                items[i] = v;
            } else if let V::Str(key) = &k {
                if key.as_ref() == "length" {
                    let len = num(&v) as usize;
                    x.borrow_mut().resize(len, V::Undef);
                }
            }
        }
        V::Null | V::Undef => type_error(format!("Cannot set properties of {} (setting '{}')", str_of(&o), str_of(&k))),
        _ => {}
    }
    o
}

pub fn values(o: V) -> Vec<V> {
    match &o {
        V::Arr(a) => a.borrow().clone(),
        V::Str(t) => t.chars().map(|c| s(&c.to_string())).collect(),
        _ => type_error(format!("{} is not iterable", str_of(&o))),
    }
}

pub fn keys(o: V) -> Vec<V> {
    match &o {
        V::Obj(v) => v.borrow().keys.iter().map(|k| s(k)).collect(),
        V::Arr(a) => (0..a.borrow().len()).map(|i| s(&i.to_string())).collect(),
        V::Str(t) => (0..char_len(t)).map(|i| s(&i.to_string())).collect(),
        _ => Vec::new(),
    }
}

pub fn spread(parts: Vec<Vec<V>>) -> V {
    arr(parts.into_iter().flatten().collect())
}

pub fn call(f: V, args: Vec<V>) -> V {
    match &f {
        V::Fun(g) => g(args),
        _ => type_error(format!("{} is not a function", str_of(&f))),
    }
}

pub fn call_detached(f: V, args: Vec<V>) -> V {
    call(f, args)
}

pub fn call_opt(f: V, args: Vec<V>) -> V {
    if is_nullish(&f) { V::Undef } else { call(f, args) }
}

pub fn get_opt(o: V, k: &str) -> V {
    if is_nullish(&o) { V::Undef } else { get(o, k) }
}

pub fn call_error(kind: &str, msg: V) -> V {
    new_error(kind, msg)
}

pub fn to_string_m(x: V, rest: Vec<V>) -> V {
    match (&x, rest.first()) {
        (V::Null | V::Undef, _) => type_error(format!("Cannot read properties of {} (reading 'toString')", str_of(&x))),
        (V::Num(f), Some(r)) if !matches!(r, V::Undef) => {
            let radix = num(r) as u32;
            if !(2..=36).contains(&radix) {
                throw(V::Err(Rc::new(JsErr { kind: "RangeError".to_string(), message: "toString() radix must be between 2 and 36".to_string() })));
            }
            s(&radix_str(*f, radix))
        }
        _ => str_v(x),
    }
}

/// A number in a radix, as JavaScript writes it: the integer part, then up to 52 fraction digits.
fn radix_str(f: f64, radix: u32) -> String {
    if f.is_nan() { return "NaN".to_string(); }
    if f.is_infinite() { return if f > 0.0 { "Infinity".to_string() } else { "-Infinity".to_string() }; }
    if radix == 10 { return num_str(f); }
    let neg = f < 0.0;
    let a = f.abs();
    let mut int = a.trunc();
    let mut frac = a - int;
    let digits: Vec<char> = "0123456789abcdefghijklmnopqrstuvwxyz".chars().collect();
    let mut ip = Vec::new();
    if int == 0.0 { ip.push('0'); }
    while int >= 1.0 {
        let d = (int % radix as f64) as usize;
        ip.push(digits[d]);
        int = (int / radix as f64).trunc();
    }
    ip.reverse();
    let mut out: String = ip.into_iter().collect();
    if frac > 0.0 {
        out.push('.');
        let mut count = 0;
        while frac > 0.0 && count < 52 {
            frac *= radix as f64;
            let d = frac.trunc() as usize;
            out.push(digits[d]);
            frac -= d as f64;
            count += 1;
        }
    }
    if neg { format!("-{}", out) } else { out }
}

pub fn platform(name: &str) -> V {
    V::Undef
}

pub fn freeze(x: V) -> V {
    x
}

pub fn idx_opt(o: V, i: V) -> V { if is_nullish(&o) { V::Undef } else { idx(o, i) } }
pub fn comma(a: V, b: V) -> V { b }
pub fn void_of(a: V) -> V { V::Undef }
pub fn template(texts: &[&str], vals: Vec<V>) -> V {
    let mut out = String::new();
    for (i, t) in texts.iter().enumerate() {
        out.push_str(t);
        if let Some(v) = vals.get(i) {
            out.push_str(&str_of(v));
        }
    }
    s(&out)
}
pub fn add_assign(a: V, b: V) -> V { add(a, b) }
pub fn sub_assign(a: V, b: V) -> V { sub(a, b) }
pub fn mul_assign(a: V, b: V) -> V { mul(a, b) }
pub fn div_assign(a: V, b: V) -> V { div(a, b) }
pub fn rem_assign(a: V, b: V) -> V { rem(a, b) }
pub fn pre_inc(a: V) -> V { n(num(&a) + 1.0) }
pub fn post_inc(a: V) -> V { n(num(&a) + 1.0) }
pub fn pre_dec(a: V) -> V { n(num(&a) - 1.0) }
pub fn post_dec(a: V) -> V { n(num(&a) - 1.0) }
pub fn put_member(o: V, k: &str, v: V) -> V { put(o, s(k), v) }
pub fn math_pow(a: V, b: V) -> V { pow(a, b) }
pub fn math_abs(x: V) -> V { n(num(&x).abs()) }
pub fn math_floor(x: V) -> V { n(num(&x).floor()) }
pub fn math_ceil(x: V) -> V { n(num(&x).ceil()) }
pub fn math_trunc(x: V) -> V { n(num(&x).trunc()) }
pub fn math_sqrt(x: V) -> V { n(num(&x).sqrt()) }
pub fn number_of(x: V) -> V { n(num(&x)) }
pub fn boolean_of(x: V) -> V { B(truthy(&x)) }
pub fn global_is_nan(x: V) -> V { B(num(&x).is_nan()) }
pub fn global_is_finite(x: V) -> V { B(num(&x).is_finite()) }

pub fn arg(args: &[V], i: usize) -> V {
    args.get(i).cloned().unwrap_or(V::Undef)
}

pub fn rest_args(args: &[V], i: usize) -> V {
    arr(args.iter().skip(i).cloned().collect())
}

pub fn has_key(k: V, o: V) -> V {
    let key = str_of(&k);
    match &o {
        V::Obj(v) => B(v.borrow().vals.contains_key(&key)),
        V::Arr(a) => {
            if key == "length" {
                return B(true);
            }
            B(matches!(key.parse::<usize>(), Ok(i) if i.to_string() == key && i < a.borrow().len()))
        }
        _ => type_error(format!("Cannot use 'in' operator to search for '{}' in {}", key, str_of(&o))),
    }
}

pub fn is_array(x: V) -> V { B(matches!(x, V::Arr(_))) }

pub fn round(x: V) -> V { n((num(&x) + 0.5).floor()) }

pub fn math_max(xs: Vec<V>) -> V {
    let mut m = f64::NEG_INFINITY;
    for x in xs {
        let f = num(&x);
        if f.is_nan() {
            return n(f64::NAN);
        }
        if f > m {
            m = f;
        }
    }
    n(m)
}

pub fn math_min(xs: Vec<V>) -> V {
    let mut m = f64::INFINITY;
    for x in xs {
        let f = num(&x);
        if f.is_nan() {
            return n(f64::NAN);
        }
        if f < m {
            m = f;
        }
    }
    n(m)
}

pub fn str_method(x: &V) -> String {
    match x {
        V::Str(t) => t.to_string(),
        V::Null | V::Undef => type_error(format!("Cannot read properties of {}", str_of(x))),
        other => str_of(other),
    }
}

fn clamp_index(i: V, len: usize, default: usize) -> usize {
    if let V::Undef = i {
        return default;
    }
    let f = num(&i).trunc();
    let f = if f.is_nan() { 0.0 } else { f };
    if f < 0.0 {
        let r = len as f64 + f;
        return if r < 0.0 { 0 } else { r as usize };
    }
    if f > len as f64 { len } else { f as usize }
}

pub fn index_of(x: V, y: V) -> V {
    match &x {
        V::Arr(a) => n(a.borrow().iter().position(|e| seq_b(e, &y)).map(|i| i as f64).unwrap_or(-1.0)),
        _ => {
            let t: Vec<char> = str_method(&x).chars().collect();
            let p: Vec<char> = str_of(&y).chars().collect();
            if p.is_empty() {
                return n(0.0);
            }
            for i in 0..t.len() {
                if t[i..].starts_with(&p) {
                    return n(i as f64);
                }
            }
            n(-1.0)
        }
    }
}

pub fn includes(x: V, y: V) -> V {
    match &x {
        V::Arr(a) => B(a.borrow().iter().any(|e| seq_b(e, &y) || (matches!((e, &y), (V::Num(p), V::Num(q)) if p.is_nan() && q.is_nan())))),
        _ => B(str_method(&x).contains(&str_of(&y))),
    }
}

pub fn slice(x: V, a: V, b: V) -> V {
    match &x {
        V::Arr(items) => {
            let items = items.borrow();
            let (i, j) = (clamp_index(a, items.len(), 0), clamp_index(b, items.len(), items.len()));
            arr(if i < j { items[i..j].to_vec() } else { Vec::new() })
        }
        _ => {
            let t: Vec<char> = str_method(&x).chars().collect();
            let (i, j) = (clamp_index(a, t.len(), 0), clamp_index(b, t.len(), t.len()));
            s(&(if i < j { t[i..j].iter().collect::<String>() } else { String::new() }))
        }
    }
}

pub fn substring(x: V, a: V, b: V) -> V {
    let t: Vec<char> = str_method(&x).chars().collect();
    let clamp = |v: V, d: usize| -> usize {
        if let V::Undef = v {
            return d;
        }
        let f = num(&v);
        if f.is_nan() || f < 0.0 { 0 } else if f > t.len() as f64 { t.len() } else { f as usize }
    };
    let (mut i, mut j) = (clamp(a, 0), clamp(b, t.len()));
    if i > j {
        std::mem::swap(&mut i, &mut j);
    }
    s(&t[i..j].iter().collect::<String>())
}

pub fn split(x: V, sep: V) -> V {
    let t = str_method(&x);
    match sep {
        V::Undef => arr(vec![s(&t)]),
        other => {
            let p = str_of(&other);
            if p.is_empty() {
                return arr(t.chars().map(|c| s(&c.to_string())).collect());
            }
            arr(t.split(p.as_str()).map(s).collect())
        }
    }
}

pub fn join(x: V, sep: V) -> V {
    let p = match sep { V::Undef => ",".to_string(), other => str_of(&other) };
    match &x {
        V::Arr(a) => s(&a
            .borrow()
            .iter()
            .map(|e| if is_nullish(e) { String::new() } else { str_of(e) })
            .collect::<Vec<_>>()
            .join(&p)),
        _ => type_error("join is not a function".to_string()),
    }
}

pub fn push(x: V, items: Vec<V>) -> V {
    match &x {
        V::Arr(a) => {
            let mut a = a.borrow_mut();
            a.extend(items);
            n(a.len() as f64)
        }
        _ => type_error("push is not a function".to_string()),
    }
}

fn items_of(x: &V, method: &str) -> Vec<V> {
    match x {
        V::Arr(a) => a.borrow().clone(),
        _ => type_error(format!("{}.{} is not a function", str_of(x), method)),
    }
}

pub fn map_arr(x: V, f: V) -> V {
    let items = items_of(&x, "map");
    arr(items.into_iter().enumerate().map(|(i, e)| call(f.clone(), vec![e, n(i as f64), x.clone()])).collect())
}

pub fn filter_arr(x: V, f: V) -> V {
    let items = items_of(&x, "filter");
    let mut out = Vec::new();
    for (i, e) in items.into_iter().enumerate() {
        if truthy(&call(f.clone(), vec![e.clone(), n(i as f64), x.clone()])) {
            out.push(e);
        }
    }
    arr(out)
}

pub fn for_each_arr(x: V, f: V) -> V {
    for (i, e) in items_of(&x, "forEach").into_iter().enumerate() {
        call(f.clone(), vec![e, n(i as f64), x.clone()]);
    }
    V::Undef
}

pub fn some_arr(x: V, f: V) -> V {
    for (i, e) in items_of(&x, "some").into_iter().enumerate() {
        if truthy(&call(f.clone(), vec![e, n(i as f64), x.clone()])) {
            return B(true);
        }
    }
    B(false)
}

pub fn every_arr(x: V, f: V) -> V {
    for (i, e) in items_of(&x, "every").into_iter().enumerate() {
        if !truthy(&call(f.clone(), vec![e, n(i as f64), x.clone()])) {
            return B(false);
        }
    }
    B(true)
}

pub fn find_arr(x: V, f: V) -> V {
    for (i, e) in items_of(&x, "find").into_iter().enumerate() {
        if truthy(&call(f.clone(), vec![e.clone(), n(i as f64), x.clone()])) {
            return e;
        }
    }
    V::Undef
}

pub fn find_index_arr(x: V, f: V) -> V {
    for (i, e) in items_of(&x, "findIndex").into_iter().enumerate() {
        if truthy(&call(f.clone(), vec![e, n(i as f64), x.clone()])) {
            return n(i as f64);
        }
    }
    n(-1.0)
}

pub fn reduce_arr(x: V, rest: Vec<V>) -> V {
    let items = items_of(&x, "reduce");
    let f = rest.get(0).cloned().unwrap_or(V::Undef);
    let mut it = items.into_iter().enumerate();
    let mut acc = match rest.get(1) {
        Some(init) => init.clone(),
        None => match it.next() {
            Some((_, e)) => e,
            None => type_error("Reduce of empty array with no initial value".to_string()),
        },
    };
    for (i, e) in it {
        acc = call(f.clone(), vec![acc, e, n(i as f64), x.clone()]);
    }
    acc
}

pub fn concat(x: V, rest: Vec<V>) -> V {
    match &x {
        V::Arr(a) => {
            let mut out = a.borrow().clone();
            for r in rest {
                match &r {
                    V::Arr(b) => out.extend(b.borrow().iter().cloned()),
                    _ => out.push(r),
                }
            }
            arr(out)
        }
        _ => {
            let mut t = str_method(&x);
            for r in rest {
                t.push_str(&str_of(&r));
            }
            s(&t)
        }
    }
}

pub fn char_at(x: V, i: V) -> V {
    let t: Vec<char> = str_method(&x).chars().collect();
    let f = if let V::Undef = i { 0.0 } else { num(&i).trunc() };
    if f >= 0.0 && (f as usize) < t.len() { s(&t[f as usize].to_string()) } else { s("") }
}

pub fn char_code_at(x: V, i: V) -> V {
    let t: Vec<u16> = str_method(&x).encode_utf16().collect();
    let f = if let V::Undef = i { 0.0 } else { num(&i).trunc() };
    if f >= 0.0 && (f as usize) < t.len() { n(t[f as usize] as f64) } else { n(f64::NAN) }
}

pub fn at(x: V, i: V) -> V {
    let f = num(&i).trunc();
    let f = if f.is_nan() { 0.0 } else { f };
    match &x {
        V::Arr(a) => {
            let a = a.borrow();
            let k = if f < 0.0 { a.len() as f64 + f } else { f };
            if k >= 0.0 && (k as usize) < a.len() { a[k as usize].clone() } else { V::Undef }
        }
        _ => {
            let t: Vec<char> = str_method(&x).chars().collect();
            let k = if f < 0.0 { t.len() as f64 + f } else { f };
            if k >= 0.0 && (k as usize) < t.len() { s(&t[k as usize].to_string()) } else { V::Undef }
        }
    }
}

pub fn pop(x: V) -> V {
    match &x {
        V::Arr(a) => a.borrow_mut().pop().unwrap_or(V::Undef),
        _ => type_error("pop is not a function".to_string()),
    }
}

pub fn shift(x: V) -> V {
    match &x {
        V::Arr(a) => {
            let mut a = a.borrow_mut();
            if a.is_empty() { V::Undef } else { a.remove(0) }
        }
        _ => type_error("shift is not a function".to_string()),
    }
}

pub fn reverse(x: V) -> V {
    match &x {
        V::Arr(a) => {
            a.borrow_mut().reverse();
            x.clone()
        }
        _ => type_error("reverse is not a function".to_string()),
    }
}

pub fn trim(x: V) -> V { s(str_method(&x).trim()) }
pub fn to_upper(x: V) -> V { s(&str_method(&x).to_uppercase()) }
pub fn to_lower(x: V) -> V { s(&str_method(&x).to_lowercase()) }
pub fn starts_with(x: V, y: V) -> V { B(str_method(&x).starts_with(str_of(&y).as_str())) }
pub fn ends_with(x: V, y: V) -> V { B(str_method(&x).ends_with(str_of(&y).as_str())) }

pub fn replace_str(x: V, pat: V, with: V) -> V {
    if let V::Re(r) = &pat {
        return re_replace(r, str_method(&x), with);
    }
    let t = str_method(&x);
    let p = str_of(&pat);
    match t.find(p.as_str()) {
        None => s(&t),
        Some(i) => {
            let rep = match &with {
                V::Fun(_) => str_of(&call(with.clone(), vec![s(&p), n(i as f64), s(&t)])),
                other => expand_replacement(&str_of(other), &t, i, &p),
            };
            s(&format!("{}{}{}", &t[..i], rep, &t[i + p.len()..]))
        }
    }
}

fn expand_replacement(r: &str, t: &str, at: usize, m: &str) -> String {
    let c: Vec<char> = r.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '$' && i + 1 < c.len() {
            match c[i + 1] {
                '$' => { out.push('$'); i += 2; continue; }
                '&' => { out.push_str(m); i += 2; continue; }
                '\x60' => { out.push_str(&t[..at]); i += 2; continue; }
                '\'' => { out.push_str(&t[at + m.len()..]); i += 2; continue; }
                _ => {}
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

pub fn parse_int(x: V, radix: V) -> V {
    let t = str_of(&x);
    let mut t = t.trim();
    let mut sign = 1.0;
    if let Some(r) = t.strip_prefix('-') { sign = -1.0; t = r; } else if let Some(r) = t.strip_prefix('+') { t = r; }
    let mut base = match radix { V::Undef => 0, other => num(&other) as u32 };
    if base == 0 || base == 16 {
        if let Some(r) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) { t = r; base = 16; }
    }
    if base == 0 { base = 10; }
    if !(2..=36).contains(&base) { return n(f64::NAN); }
    let mut v = 0.0;
    let mut any = false;
    for ch in t.chars() {
        match ch.to_digit(base) {
            Some(d) => { v = v * base as f64 + d as f64; any = true; }
            None => break,
        }
    }
    if any { n(sign * v) } else { n(f64::NAN) }
}

pub fn to_int32(x: &V) -> i32 {
    let f = num(x);
    if !f.is_finite() { return 0; }
    let m = f.trunc().rem_euclid(4294967296.0);
    (m as u64 as u32) as i32
}

pub fn to_uint32(x: &V) -> u32 { to_int32(x) as u32 }

pub fn band(a: V, b: V) -> V { n((to_int32(&a) & to_int32(&b)) as f64) }
pub fn bor(a: V, b: V) -> V { n((to_int32(&a) | to_int32(&b)) as f64) }
pub fn bxor(a: V, b: V) -> V { n((to_int32(&a) ^ to_int32(&b)) as f64) }
pub fn shl(a: V, b: V) -> V { n(to_int32(&a).wrapping_shl(to_uint32(&b) & 31) as f64) }
pub fn shr(a: V, b: V) -> V { n((to_int32(&a) >> (to_uint32(&b) & 31)) as f64) }
pub fn ushr(a: V, b: V) -> V { n((to_uint32(&a) >> (to_uint32(&b) & 31)) as f64) }
pub fn bnot(a: V) -> V { n((!to_int32(&a)) as f64) }

pub fn is_finite_number(x: V) -> V { B(matches!(x, V::Num(f) if f.is_finite())) }
pub fn is_integer_number(x: V) -> V { B(matches!(x, V::Num(f) if f.is_finite() && f == f.trunc())) }
pub fn is_nan_number(x: V) -> V { B(matches!(x, V::Num(f) if f.is_nan())) }

pub fn object_keys(x: V) -> V { arr(keys(x)) }

pub const NONE: V = V::Undef;

pub fn uninit() -> V {
    V::Undef
}

pub fn re_call(pattern: V, flags: V) -> V {
    re_new(pattern, flags)
}

pub fn try_catch(parts: Vec<V>) -> V {
    let body = parts.get(0).cloned().unwrap_or(V::Undef);
    let handler = parts.get(1).cloned().unwrap_or(V::Undef);
    let finalizer = parts.get(2).cloned().unwrap_or(V::Undef);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(body.clone(), vec![])));
    let outcome = match outcome {
        Ok(v) => Ok(v),
        Err(payload) => {
            let thrown = take_thrown(payload);
            match &handler {
                V::Undef => Err(thrown),
                _ => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(handler.clone(), vec![thrown])))
                    .map_err(take_thrown),
            }
        }
    };
    if !matches!(finalizer, V::Undef) {
        let done = call(finalizer, vec![]);
        if let V::Arr(a) = &done {
            if a.borrow().first().map(|x| seq_b(x, &n(1.0))).unwrap_or(false) {
                return done;
            }
        }
    }
    match outcome {
        Ok(v) => v,
        Err(t) => throw(t),
    }
}

pub fn fn_string() -> V { fun(|a| str_v(arg(&a, 0))) }
pub fn fn_number() -> V { fun(|a| n(num(&arg(&a, 0)))) }
pub fn fn_boolean() -> V { fun(|a| B(truthy(&arg(&a, 0)))) }
pub fn fn_parse_int() -> V { fun(|a| parse_int(arg(&a, 0), arg(&a, 1))) }

// --- Regular expressions: a backtracking matcher for JavaScript's syntax, over chars. ---

pub struct Re {
    pub source: String,
    pub flags: String,
    pub global: bool,
    icase: bool,
    multiline: bool,
    dotall: bool,
    node: RNode,
    groups: usize,
}

enum RNode {
    Empty,
    Char(char),
    Any,
    Class(bool, Vec<CItem>),
    Start,
    End,
    WordB(bool),
    Group(Box<RNode>, Option<usize>),
    Look(bool, Box<RNode>),
    Backref(usize),
    Concat(Vec<RNode>),
    Alt(Vec<RNode>),
    Repeat(Box<RNode>, usize, usize, bool),
}

enum CItem {
    Range(char, char),
    Digit(bool),
    Word(bool),
    Space(bool),
}

struct RParse<'a> {
    c: &'a [char],
    i: usize,
    groups: usize,
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

impl<'a> RParse<'a> {
    fn peek(&self) -> Option<char> {
        self.c.get(self.i).copied()
    }
    fn alt(&mut self) -> Result<RNode, String> {
        let mut alts = vec![self.seq()?];
        while self.peek() == Some('|') {
            self.i += 1;
            alts.push(self.seq()?);
        }
        Ok(if alts.len() == 1 { alts.pop().unwrap() } else { RNode::Alt(alts) })
    }
    fn seq(&mut self) -> Result<RNode, String> {
        let mut items = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            let atom = self.atom()?;
            let atom = self.quantified(atom)?;
            items.push(atom);
        }
        Ok(if items.len() == 1 { items.pop().unwrap() } else { RNode::Concat(items) })
    }
    fn number(&mut self) -> Option<usize> {
        let start = self.i;
        while matches!(self.peek(), Some(d) if d.is_ascii_digit()) {
            self.i += 1;
        }
        if start == self.i { None } else { self.c[start..self.i].iter().collect::<String>().parse().ok() }
    }
    fn quantified(&mut self, atom: RNode) -> Result<RNode, String> {
        let (min, max) = match self.peek() {
            Some('*') => { self.i += 1; (0, usize::MAX) }
            Some('+') => { self.i += 1; (1, usize::MAX) }
            Some('?') => { self.i += 1; (0, 1) }
            Some('{') => {
                let save = self.i;
                self.i += 1;
                match self.number() {
                    None => { self.i = save; return Ok(atom); }
                    Some(lo) => {
                        let hi = if self.peek() == Some(',') {
                            self.i += 1;
                            self.number().unwrap_or(usize::MAX)
                        } else {
                            lo
                        };
                        if self.peek() != Some('}') { self.i = save; return Ok(atom); }
                        self.i += 1;
                        (lo, hi)
                    }
                }
            }
            _ => return Ok(atom),
        };
        let greedy = if self.peek() == Some('?') { self.i += 1; false } else { true };
        Ok(RNode::Repeat(Box::new(atom), min, max, greedy))
    }
    fn escape_char(&mut self, e: char) -> Result<char, String> {
        Ok(match e {
            'n' => '\n',
            't' => '\t',
            'r' => '\r',
            'f' => '\u{c}',
            'v' => '\u{b}',
            '0' => '\0',
            'x' => {
                let h: String = self.c.get(self.i..self.i + 2).ok_or("bad escape")?.iter().collect();
                self.i += 2;
                char::from_u32(u32::from_str_radix(&h, 16).map_err(|_| "bad escape")?).ok_or("bad escape")?
            }
            'u' => {
                let h: String = self.c.get(self.i..self.i + 4).ok_or("bad escape")?.iter().collect();
                self.i += 4;
                char::from_u32(u32::from_str_radix(&h, 16).map_err(|_| "bad escape")?).unwrap_or('\u{fffd}')
            }
            other => other,
        })
    }
    fn atom(&mut self) -> Result<RNode, String> {
        let c = self.peek().ok_or("unexpected end")?;
        self.i += 1;
        Ok(match c {
            '.' => RNode::Any,
            '^' => RNode::Start,
            '$' => RNode::End,
            '(' => {
                let mut capture = true;
                let mut look: Option<bool> = None;
                if self.peek() == Some('?') {
                    self.i += 1;
                    match self.peek() {
                        Some(':') => { self.i += 1; capture = false; }
                        Some('=') => { self.i += 1; look = Some(true); }
                        Some('!') => { self.i += 1; look = Some(false); }
                        Some('<') => {
                            self.i += 1;
                            while self.peek().map(|x| x != '>').unwrap_or(false) { self.i += 1; }
                            self.i += 1;
                        }
                        _ => return Err("unsupported group".to_string()),
                    }
                }
                let index = if capture && look.is_none() { self.groups += 1; Some(self.groups) } else { None };
                let inner = self.alt()?;
                if self.peek() != Some(')') { return Err("unterminated group".to_string()); }
                self.i += 1;
                match look {
                    Some(pos) => RNode::Look(pos, Box::new(inner)),
                    None => RNode::Group(Box::new(inner), index),
                }
            }
            '[' => {
                let neg = if self.peek() == Some('^') { self.i += 1; true } else { false };
                let mut items = Vec::new();
                let mut first = true;
                loop {
                    let x = self.peek().ok_or("unterminated class")?;
                    if x == ']' && !first { self.i += 1; break; }
                    if x == ']' { self.i += 1; break; }
                    first = false;
                    self.i += 1;
                    let lo = if x == '\\' {
                        let e = self.peek().ok_or("bad escape")?;
                        self.i += 1;
                        match e {
                            'd' => { items.push(CItem::Digit(true)); continue; }
                            'D' => { items.push(CItem::Digit(false)); continue; }
                            'w' => { items.push(CItem::Word(true)); continue; }
                            'W' => { items.push(CItem::Word(false)); continue; }
                            's' => { items.push(CItem::Space(true)); continue; }
                            'S' => { items.push(CItem::Space(false)); continue; }
                            'b' => '\u{8}',
                            other => self.escape_char(other)?,
                        }
                    } else {
                        x
                    };
                    if self.peek() == Some('-') && self.c.get(self.i + 1).map(|&y| y != ']').unwrap_or(false) {
                        self.i += 1;
                        let y = self.peek().ok_or("bad range")?;
                        self.i += 1;
                        let hi = if y == '\\' {
                            let e = self.peek().ok_or("bad escape")?;
                            self.i += 1;
                            self.escape_char(e)?
                        } else {
                            y
                        };
                        items.push(CItem::Range(lo, hi));
                    } else {
                        items.push(CItem::Range(lo, lo));
                    }
                }
                RNode::Class(neg, items)
            }
            '\\' => {
                let e = self.peek().ok_or("bad escape")?;
                self.i += 1;
                match e {
                    'd' => RNode::Class(false, vec![CItem::Digit(true)]),
                    'D' => RNode::Class(false, vec![CItem::Digit(false)]),
                    'w' => RNode::Class(false, vec![CItem::Word(true)]),
                    'W' => RNode::Class(false, vec![CItem::Word(false)]),
                    's' => RNode::Class(false, vec![CItem::Space(true)]),
                    'S' => RNode::Class(false, vec![CItem::Space(false)]),
                    'b' => RNode::WordB(true),
                    'B' => RNode::WordB(false),
                    '1'..='9' => {
                        self.i -= 1;
                        RNode::Backref(self.number().unwrap_or(0))
                    }
                    other => RNode::Char(self.escape_char(other)?),
                }
            }
            other => RNode::Char(other),
        })
    }
}

fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

type Caps = Vec<Option<(usize, usize)>>;

impl Re {
    fn class_has(&self, items: &[CItem], c: char) -> bool {
        items.iter().any(|it| match it {
            CItem::Range(lo, hi) => {
                (*lo <= c && c <= *hi)
                    || (self.icase && {
                        let l = fold(c);
                        let u = c.to_uppercase().next().unwrap_or(c);
                        (*lo <= l && l <= *hi) || (*lo <= u && u <= *hi)
                    })
            }
            CItem::Digit(p) => c.is_ascii_digit() == *p,
            CItem::Word(p) => is_word(c) == *p,
            CItem::Space(p) => is_space(c) == *p,
        })
    }

    fn m(&self, n: &RNode, s: &[char], i: usize, caps: &mut Caps, k: &mut dyn FnMut(usize, &mut Caps) -> bool) -> bool {
        match n {
            RNode::Empty => k(i, caps),
            RNode::Char(c) => i < s.len() && (s[i] == *c || (self.icase && fold(s[i]) == fold(*c))) && k(i + 1, caps),
            RNode::Any => i < s.len() && (self.dotall || !matches!(s[i], '\n' | '\r' | '\u{2028}' | '\u{2029}')) && k(i + 1, caps),
            RNode::Class(neg, items) => i < s.len() && self.class_has(items, s[i]) != *neg && k(i + 1, caps),
            RNode::Start => (i == 0 || (self.multiline && s[i - 1] == '\n')) && k(i, caps),
            RNode::End => (i == s.len() || (self.multiline && s[i] == '\n')) && k(i, caps),
            RNode::WordB(want) => {
                let a = i > 0 && is_word(s[i - 1]);
                let b = i < s.len() && is_word(s[i]);
                ((a != b) == *want) && k(i, caps)
            }
            RNode::Group(inner, index) => match index {
                None => self.m(inner, s, i, caps, k),
                Some(g) => {
                    let g = *g;
                    self.m(inner, s, i, caps, &mut |j, c: &mut Caps| {
                        let old = c[g];
                        c[g] = Some((i, j));
                        if k(j, c) {
                            true
                        } else {
                            c[g] = old;
                            false
                        }
                    })
                }
            },
            RNode::Look(pos, inner) => {
                let mut trial = caps.clone();
                let found = self.m(inner, s, i, &mut trial, &mut |_: usize, _: &mut Caps| true);
                if *pos {
                    if !found {
                        return false;
                    }
                    let saved = caps.clone();
                    *caps = trial;
                    if k(i, caps) {
                        true
                    } else {
                        *caps = saved;
                        false
                    }
                } else {
                    !found && k(i, caps)
                }
            }
            RNode::Backref(g) => match caps.get(*g).copied().flatten() {
                None => k(i, caps),
                Some((a, b)) => {
                    let len = b - a;
                    if i + len > s.len() {
                        return false;
                    }
                    let same = (0..len).all(|d| s[a + d] == s[i + d] || (self.icase && fold(s[a + d]) == fold(s[i + d])));
                    same && k(i + len, caps)
                }
            },
            RNode::Concat(items) => self.seq(items, s, i, caps, k),
            RNode::Alt(alts) => alts.iter().any(|a| self.m(a, s, i, caps, k)),
            RNode::Repeat(inner, min, max, greedy) => self.rep(inner, *min, *max, *greedy, 0, s, i, caps, k),
        }
    }

    fn seq(&self, items: &[RNode], s: &[char], i: usize, caps: &mut Caps, k: &mut dyn FnMut(usize, &mut Caps) -> bool) -> bool {
        match items.split_first() {
            None => k(i, caps),
            Some((first, rest)) => self.m(first, s, i, caps, &mut |j, c: &mut Caps| self.seq(rest, s, j, c, k)),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn rep(&self, inner: &RNode, min: usize, max: usize, greedy: bool, count: usize, s: &[char], i: usize, caps: &mut Caps, k: &mut dyn FnMut(usize, &mut Caps) -> bool) -> bool {
        if count < min {
            return self.m(inner, s, i, caps, &mut |j, c: &mut Caps| self.rep(inner, min, max, greedy, count + 1, s, j, c, k));
        }
        let mut again = |caps: &mut Caps, k: &mut dyn FnMut(usize, &mut Caps) -> bool| {
            count < max && self.m(inner, s, i, caps, &mut |j, c: &mut Caps| j != i && self.rep(inner, min, max, greedy, count + 1, s, j, c, k))
        };
        if greedy {
            again(caps, k) || k(i, caps)
        } else {
            k(i, caps) || again(caps, k)
        }
    }

    /// The first match at or after from: each group's span, group 0 the whole match.
    pub fn exec(&self, s: &[char], from: usize) -> Option<Caps> {
        for start in from..=s.len() {
            let mut caps: Caps = vec![None; self.groups + 1];
            let mut end = None;
            if self.m(&self.node, s, start, &mut caps, &mut |j: usize, _: &mut Caps| {
                end = Some(j);
                true
            }) {
                caps[0] = Some((start, end.unwrap_or(start)));
                return Some(caps);
            }
        }
        None
    }
}

thread_local! {
    static RE_CACHE: RefCell<HashMap<String, Rc<Re>>> = RefCell::new(HashMap::new());
}

pub fn compile_re(source: &str, flags: &str) -> Result<Rc<Re>, String> {
    let key = format!("{}/{}", source, flags);
    if let Some(r) = RE_CACHE.with(|c| c.borrow().get(&key).cloned()) {
        return Ok(r);
    }
    let chars: Vec<char> = source.chars().collect();
    let mut p = RParse { c: &chars, i: 0, groups: 0 };
    let node = if chars.is_empty() { RNode::Empty } else { p.alt()? };
    if p.i < chars.len() {
        return Err("unmatched ')'".to_string());
    }
    let r = Rc::new(Re {
        source: source.to_string(),
        flags: flags.to_string(),
        global: flags.contains('g'),
        icase: flags.contains('i'),
        multiline: flags.contains('m'),
        dotall: flags.contains('s'),
        node,
        groups: p.groups,
    });
    RE_CACHE.with(|c| c.borrow_mut().insert(key, r.clone()));
    Ok(r)
}

/// A regular expression literal: checked when it is lowered.
pub fn re(source: &str, flags: &str) -> V {
    V::Re(compile_re(source, flags).expect("a regular expression the lowering checked"))
}

/// new RegExp(pattern, flags): a SyntaxError for a pattern it cannot read.
pub fn re_new(pattern: V, flags: V) -> V {
    let source = match &pattern { V::Re(r) => r.source.clone(), V::Undef => "(?:)".to_string(), other => str_of(other) };
    let f = match flags { V::Undef => String::new(), other => str_of(&other) };
    match compile_re(&source, &f) {
        Ok(r) => V::Re(r),
        Err(e) => throw(V::Err(Rc::new(JsErr { kind: "SyntaxError".to_string(), message: format!("Invalid regular expression: /{}/: {}", source, e) }))),
    }
}

pub fn re_test(r: V, x: V) -> V {
    match &r {
        V::Re(re) => {
            let t: Vec<char> = str_of(&x).chars().collect();
            B(re.exec(&t, 0).is_some())
        }
        _ => type_error("test is not a function".to_string()),
    }
}

fn span(t: &[char], a: usize, b: usize) -> String {
    t[a..b].iter().collect()
}

fn re_replace(r: &Re, text: String, with: V) -> V {
    let t: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut last = 0;
    let mut from = 0;
    while from <= t.len() {
        let caps = match r.exec(&t, from) {
            Some(c) => c,
            None => break,
        };
        let (a, b) = caps[0].unwrap();
        out.push_str(&span(&t, last, a));
        match &with {
            V::Fun(_) => {
                let mut args: Vec<V> = caps.iter().map(|g| g.map(|(x, y)| s(&span(&t, x, y))).unwrap_or(V::Undef)).collect();
                args.push(n(a as f64));
                args.push(s(&text));
                out.push_str(&str_of(&call(with.clone(), args)));
            }
            other => out.push_str(&expand_groups(&str_of(other), &t, &caps)),
        }
        last = b;
        if !r.global {
            break;
        }
        from = if b == a { b + 1 } else { b };
    }
    if last <= t.len() {
        out.push_str(&span(&t, last, t.len()));
    }
    s(&out)
}

fn expand_groups(rep: &str, t: &[char], caps: &Caps) -> String {
    let c: Vec<char> = rep.chars().collect();
    let (a, b) = caps[0].unwrap();
    let groups = caps.len() - 1;
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '$' && i + 1 < c.len() {
            let d = c[i + 1];
            match d {
                '$' => { out.push('$'); i += 2; continue; }
                '&' => { out.push_str(&span(t, a, b)); i += 2; continue; }
                '\x60' => { out.push_str(&span(t, 0, a)); i += 2; continue; }
                '\'' => { out.push_str(&span(t, b, t.len())); i += 2; continue; }
                '0'..='9' => {
                    let mut k = d as usize - '0' as usize;
                    let mut used = 1;
                    if let Some(e) = c.get(i + 2).filter(|e| e.is_ascii_digit()) {
                        let kk = k * 10 + (*e as usize - '0' as usize);
                        if kk >= 1 && kk <= groups { k = kk; used = 2; }
                    }
                    if k >= 1 && k <= groups {
                        if let Some((x, y)) = caps[k] { out.push_str(&span(t, x, y)); }
                        i += 1 + used;
                        continue;
                    }
                }
                _ => {}
            }
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

pub fn match_str(x: V, r: V) -> V {
    let text = str_method(&x);
    let re = match &r {
        V::Re(re) => re.clone(),
        other => {
            let src: String = str_of(other).chars().map(|c| if "\\^$.|?*+()[]{}/".contains(c) { format!("\\{}", c) } else { c.to_string() }).collect();
            compile_re(&src, "").unwrap()
        }
    };
    let t: Vec<char> = text.chars().collect();
    if re.global {
        let mut all = Vec::new();
        let mut from = 0;
        while from <= t.len() {
            match re.exec(&t, from) {
                None => break,
                Some(caps) => {
                    let (a, b) = caps[0].unwrap();
                    all.push(s(&span(&t, a, b)));
                    from = if b == a { b + 1 } else { b };
                }
            }
        }
        return if all.is_empty() { V::Null } else { arr(all) };
    }
    match re.exec(&t, 0) {
        None => V::Null,
        Some(caps) => arr(caps.iter().map(|g| g.map(|(a, b)| s(&span(&t, a, b))).unwrap_or(V::Undef)).collect()),
    }
}
`;
