import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateDynamicCode } from '../src/index.ts';
import { maskStringsAndComments } from '../src/dynamic.ts';

const found = (code: string) => locateDynamicCode(code).map(({ match }) => match);

test('eval, new Function and a string given to setTimeout / setInterval are reported', () => {
  assert.deepEqual(found('eval(code)'), ['eval(code)']);
  assert.deepEqual(found('var f = new Function("a", "return a")'), ['new Function("a", "return a")']);
  assert.deepEqual(found('setTimeout("tick()", 10)'), ['setTimeout("tick()", 10)']);
  assert.deepEqual(found("setInterval('tick()', 10)"), ["setInterval('tick()', 10)"]);
  assert.deepEqual(found('setTimeout(`go(${n})`)'), ['setTimeout(`go(${n})`)']);
  assert.deepEqual(found('window.eval(x);globalThis.eval(y);self.eval(z)'), ['window.eval(x)', 'globalThis.eval(y)', 'self.eval(z)']);
  assert.deepEqual(found('window.setTimeout("x()")'), ['window.setTimeout("x()")']);
  assert.deepEqual(found('eval (x)'), ['eval (x)']);
});

test('where each one stands, and the rule', () => {
  const [hit] = locateDynamicCode('a=1;\n  b=eval(c)');
  assert.deepEqual(hit, { match: 'eval(c)', rule: 'dynamic-code', index: 9, line: 2, column: 5 });
});

test('words in strings, comments and regular expressions are not code', () => {
  assert.deepEqual(found('// do not eval(x)\n/* new Function("x") */ throw Error("eval() is off")'), []);
  assert.deepEqual(found('msg = \'setTimeout("x")\'; t = `eval(${1})`'), []);
  assert.deepEqual(found('if (/eval\\(/.test(s)) ok()'), []);
});

test('other objects, methods named eval and timers given a function are not reported', () => {
  assert.deepEqual(found('vm.eval(code); page.eval(x); obj.setTimeout("x")'), []);
  assert.deepEqual(found('class A { eval(x) { return x } }; o = {eval(e){return e}}'), []);
  assert.deepEqual(found('setTimeout(tick, 10); setInterval(() => go(), 5); new Functions(1); evaluate(x)'), []);
  assert.deepEqual(found('Function("return this")()'), []);
});

test('a minified line with an address in a string still finds the eval after it', () => {
  const line = 'var u="https://example.com/a",r=/[/"]+/g,t=`${u}`;eval(t);x=a/b/c;new Function(t)';
  assert.deepEqual(found(line), ['eval(t)', 'new Function(t)']);
});

test('the template literal code inside ${} is code', () => {
  assert.deepEqual(found('s = `a ${eval(x)} b`'), ['eval(x)']);
  assert.deepEqual(found('s = `a ${ {a:1}.a } ${eval(y)}`'), ['eval(y)']);
});

test('masking keeps offsets and line breaks', () => {
  const code = 'a="x\\"y"; // c\nb=`t${c}`';
  const masked = maskStringsAndComments(code);
  assert.equal(masked.length, code.length);
  assert.equal(masked, 'a="    ";     \nb=` ${c}`');
});
