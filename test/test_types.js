/* jshint node: true, mocha: true */

'use strict';

var types = require('../lib/types'),
    Tap = require('../lib/tap'),
    utils = require('../lib/utils'),
    assert = require('assert');


var AvscError = utils.AvscError;
var fromSchema = types.Type.fromSchema;

suite('types', function () {

  suite('from schema', function  () {

    test('unknown types', function () {
      assert.throws(function () { fromSchema('a'); }, AvscError);
      assert.throws(function () { fromSchema({type: 'b'}); }, AvscError);
    });

    test('namespaced type', function () {
      var type = fromSchema({
        type: 'record',
        name: 'Human',
        namespace: 'earth',
        fields: [
          {
            name: 'id',
            type: {type: 'fixed', name: 'Id', size: 2, namespace: 'all'}
          },
          {
            name: 'alien',
            type: {
              type: 'record',
              name: 'Alien',
              namespace: 'all',
              fields: [
                {name: 'friend', type: 'earth.Human'},
                {name: 'id', type: 'Id'},
              ]
            }
          }
        ]
      });
      assert.equal(type.name, 'earth.Human');
      assert.equal(type.fields[0].type.name, 'all.Id');
      assert.equal(type.fields[1].type.name, 'all.Alien');
    });

    test('wrapped primitive', function () {
      var type = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'nothing', type: {type: 'null'}}]
      });
      assert.equal(type.fields[0].type.type, 'null');
    });

    test('decode truncated', function () {
      var type = fromSchema('int');
      assert.throws(function () {
        type.decode(new Buffer([128]));
      }, AvscError);
    });

    test('decode bad adaptor', function () {
      var type = fromSchema('int');
      assert.throws(function () {
        type.decode(new Buffer([0]), 123);
      }, AvscError);
    });

    test('encode safe & unsafe', function () {
      var type = fromSchema('int');
      assert.throws(function () { type.encode('abc'); }, AvscError);
      type.encode('abc', {unsafe: true});
    });

    test('wrap & unwrap unions', function () {
      // Default is to wrap.
      var type;
      type = fromSchema(['null', 'int']);
      assert(type instanceof types.WrappedUnionType);
      type = fromSchema(['null', 'int'], {unwrapUnions: true});
      assert(type instanceof types.UnwrappedUnionType);
    });

    test('type hook', function () {
      var c = {};
      var o = {
        type: 'record',
        name: 'Human',
        fields: [
          {name: 'age', type: 'int'},
          {name: 'name', type: {type: 'string'}}
        ]
      };
      fromSchema(o, {typeHook: function (s) { c[this.type] = s; }});
      assert.strictEqual(c.record, o);
      assert.strictEqual(c.string, o.fields[1].type);
    });

  });

  suite('PrimitiveType', function () {

    var data = [
      {
        schema: 'boolean',
        valid: [true, false],
        invalid: [null, 'hi', undefined, 1.5, 1e28, 123124123123213]
      },
      {
        schema: 'int',
        valid: [1, -3, 12314, 0, 1e9],
        invalid: [null, 'hi', undefined, 1.5, 1e28, 123124123123213]
      },
      {
        schema: 'long',
        valid: [1, -3, 12314, 9007199254740991],
        invalid: [null, 'hi', undefined, 9007199254740992, 1.3, 1e67]
      },
      {
        schema: 'string',
        valid: ['', 'hi'],
        invalid: [null, undefined, 1, 0]
      },
      {
        schema: 'null',
        valid: [null],
        invalid: [0, 1, 'hi', undefined]
      },
      {
        schema: 'float',
        valid: [1, -3.4, 12314e31],
        invalid: [null, 'hi', undefined, 5e38],
        check: function (a, b) { assert(floatEquals(a, b)); }
      },
      {
        schema: 'double',
        valid: [1, -3.4, 12314e31, 5e37],
        invalid: [null, 'hi', undefined],
        check: function (a, b) { assert(floatEquals(a, b), '' + [a, b]); }
      },
      {
        schema: 'bytes',
        valid: [new Buffer(1), new Buffer('abc')],
        invalid: [null, 'hi', undefined, 1, 0, -3.5]
      }
    ];

    var schemas = ['foo', ''];

    testType(types.PrimitiveType, data, schemas);

    test('encode int', function () {

      var type = pType('int');
      assert.equal(type.decode(new Buffer([0x80, 0x01])), 64);
      assert(new Buffer([0]).equals(type.encode(0)));

    });

    test('decode string', function () {

      var type = pType('string');
      var buf = new Buffer([0x06, 0x68, 0x69, 0x21]);
      var s = 'hi!';
      assert.equal(type.decode(buf), s);
      assert(buf.equals(type.encode(s)));

    });

    test('encode string', function () {

      var type = pType('string');
      var buf = new Buffer([0x06, 0x68, 0x69, 0x21]);
      assert(buf.equals(type.encode('hi!', 1)));

    });

    test('adapt int > long', function () {
      var intType = pType('int');
      var longType = pType('long');
      var buf = intType.encode(123);
      assert.equal(
        longType.decode(buf, longType.createAdapter(intType)),
        123
      );
    });

    test('adapt int > [null, int]', function () {
      var wt = fromSchema('int');
      var rt = fromSchema(['null', 'int']);
      var buf = wt.encode(123);
      assert.deepEqual(
        rt.decode(buf, rt.createAdapter(wt)),
        {'int': 123}
      );
    });

    test('adapt string > bytes', function () {
      var stringT = pType('string');
      var bytesT = pType('bytes');
      var buf = stringT.encode('\x00\x01');
      assert.deepEqual(
        bytesT.decode(buf, bytesT.createAdapter(stringT)),
        new Buffer([0, 1])
      );
    });

    test('adapt invalid', function () {
      assert.throws(function () { getAdapter('int', 'long'); }, AvscError);
      assert.throws(function () { getAdapter('long', 'double'); }, AvscError);
    });

    function pType(name) { return new types.PrimitiveType(name); }

  });

  suite('EnumType', function () {

    var data = [
      {
        name: 'single symbol',
        schema: {name: 'Foo', symbols: ['HI']},
        valid: ['HI'],
        invalid: ['HEY', null, undefined, 0]
      },
      {
        name: 'number-ish as symbol',
        schema: {name: 'Foo', symbols: ['HI', 'A0']},
        valid: ['HI', 'A0'],
        invalid: ['HEY', null, undefined, 0, 'a0']
      }
    ];

    var schemas = [
      {name: 'Foo', symbols: []},
      {name: 'Foo'},
      {symbols: ['hi']},
      {name: 'G', symbols: ['0']}
    ];

    testType(types.EnumType, data, schemas);

    test('write invalid', function () {
      var type = fromSchema({type: 'enum', symbols: ['A'], name: 'a'});
      assert.throws(function () {
        type.encode('B', {unsafe: true});
      }, AvscError);
    });

    test('read invalid index', function () {
      var type = new types.EnumType({type: 'enum', symbols: ['A'], name: 'a'});
      var buf = new Buffer([2]);
      assert.throws(function () { type.decode(buf); }, AvscError);
    });

    test('adapt', function () {
      var t1, t2, buf, adapter;
      t1 = newEnum('Foo', ['bar', 'baz']);
      t2 = newEnum('Foo', ['bar', 'baz']);
      adapter = t1.createAdapter(t2);
      buf = t2.encode('bar');
      assert.equal(t1.decode(buf, adapter), 'bar');
      t2 = newEnum('Foo', ['baz', 'bar']);
      buf = t2.encode('bar');
      adapter = t1.createAdapter(t2);
      assert.notEqual(t1.decode(buf), 'bar');
      assert.equal(t1.decode(buf, adapter), 'bar');
      t1 = newEnum('Foo2', ['foo', 'baz', 'bar'], ['Foo']);
      adapter = t1.createAdapter(t2);
      assert.equal(t1.decode(buf, adapter), 'bar');
      t2 = newEnum('Foo', ['bar', 'bax']);
      assert.throws(function () { t1.createAdapter(t2); }, AvscError);
      assert.throws(function () {
        t1.createAdapter(fromSchema('int'));
      }, AvscError);
      function newEnum(name, symbols, aliases, namespace) {
        var obj = {type: 'enum', name: name, symbols: symbols};
        if (aliases !== undefined) {
          obj.aliases = aliases;
        }
        if (namespace !== undefined) {
          obj.namespace = namespace;
        }
        return new types.EnumType(obj);
      }
    });

  });

  suite('FixedType', function () {

    var data = [
      {
        name: 'size 1',
        schema: {name: 'Foo', size: 2},
        valid: [new Buffer([1, 2]), new Buffer([2, 3])],
        invalid: ['HEY', null, undefined, 0, new Buffer(1), new Buffer(3)],
        check: function (a, b) { assert(a.equals(b)); }
      }
    ];

    var schemas = [
      {name: 'Foo', size: 0},
      {name: 'Foo', size: -2},
      {size: 2},
      {name: 'Foo'},
      {}
    ];

    testType(types.FixedType, data, schemas);

    test('adapt', function () {
      var t1 = new types.FixedType({name: 'Id', size: 4});
      var t2 = new types.FixedType({name: 'Id', size: 4});
      assert.doesNotThrow(function () { t2.createAdapter(t1); });
      t2 = new types.FixedType({name: 'Id2', size: 4});
      assert.throws(function () { t2.createAdapter(t1); }, AvscError);
      t2 = new types.FixedType({name: 'Id2', size: 4, aliases: ['Id']});
      assert.doesNotThrow(function () { t2.createAdapter(t1); });
      t2 = new types.FixedType({name: 'Id2', size: 5, aliases: ['Id']});
      assert.throws(function () { t2.createAdapter(t1); }, AvscError);
    });

  });

  suite('MapType', function () {

    var data = [
      {
        name: 'int',
        schema: {values: 'int'},
        valid: [{one: 1}, {two: 2, o: 0}],
        invalid: [1, {o: null}, [], undefined, {o: 'hi'}, {1: '', 2: 3}, ''],
        check: assert.deepEqual
      },
      {
        name: 'enum',
        schema: {values: {type: 'enum', name: 'a', symbols: ['A', 'B']}},
        valid: [{a: 'A'}, {a: 'A', b: 'B'}, {}],
        invalid: [{o: 'a'}, {1: 'A', 2: 'b'}, {a: 3}],
        check: assert.deepEqual
      },
      {
        name: 'array of string',
        schema: {values: {type: 'array', items: 'string'}},
        valid: [{a: []}, {a: ['A'], b: ['B', '']}, {}],
        invalid: [{o: 'a', b: []}, {a: [1, 2]}, {a: {b: ''}}],
        check: assert.deepEqual
      }
    ];

    var schemas = [
      {},
      {values: ''},
      {values: {type: 'array'}}
    ];

    testType(types.MapType, data, schemas);

    test('adapt int values to long values', function () {
      var t1 = new types.MapType({type: 'map', values: 'int'});
      var t2 = new types.MapType({type: 'map', values: 'long'});
      var adapter = t2.createAdapter(t1);
      var obj = {one: 1, two: 2};
      var buf = t1.encode(obj);
      assert.deepEqual(t2.decode(buf, adapter), obj);
    });

    test('adapt invalid', function () {
      var t1 = new types.MapType({type: 'map', values: 'int'});
      var t2 = new types.MapType({type: 'map', values: 'string'});
      assert.throws(function () { t2.createAdapter(t1); }, AvscError);
      t2 = new types.ArrayType({type: 'array', items: 'string'});
      assert.throws(function () { t2.createAdapter(t1); }, AvscError);
    });

  });

  suite('ArrayType', function () {

    var data = [
      {
        name: 'int',
        schema: {items: 'int'},
        valid: [[1,3,4], []],
        invalid: [1, {o: null}, undefined, ['a'], [true]],
        check: assert.deepEqual
      }
    ];

    var schemas = [
      {},
      {items: ''},
    ];

    testType(types.ArrayType, data, schemas);

    test('adapt string items to bytes items', function () {
      var t1 = new types.ArrayType({type: 'array', items: 'string'});
      var t2 = new types.ArrayType({type: 'array', items: 'bytes'});
      var adapter = t2.createAdapter(t1);
      var obj = ['\x01\x02'];
      var buf = t1.encode(obj);
      assert.deepEqual(t2.decode(buf, adapter), [new Buffer([1, 2])]);
    });

    test('adapt invalid', function () {
      var t1 = new types.ArrayType({type: 'array', items: 'string'});
      var t2 = new types.ArrayType({type: 'array', items: 'long'});
      assert.throws(function () { t2.createAdapter(t1); }, AvscError);
      t2 = new types.MapType({type: 'map', values: 'string'});
      assert.throws(function () { t2.createAdapter(t1); }, AvscError);
    });

  });

  suite('WrappedUnionType', function () {

    var data = [
      {
        name: 'null & string',
        schema: ['null', 'string'],
        valid: [null, {string: 'hi'}],
        invalid: ['null', undefined, {string: 1}],
        check: assert.deepEqual
      },
      {
        name: 'qualified name',
        schema: ['null', {type: 'fixed', name: 'a.B', size: 2}],
        valid: [null, {'a.B': new Buffer(2)}],
        invalid: [new Buffer(2)],
        check: assert.deepEqual
      },
      {
        name: 'array int',
        schema: ['null', {type: 'array', items: 'int'}],
        valid: [null, {array: [1,3]}],
        invalid: [{array: ['a']}, [4]],
        check: assert.deepEqual
      },
      {
        name: 'null',
        schema: ['null'],
        valid: [null],
        invalid: [{array: ['a']}, [4], 'null'],
        check: assert.deepEqual
      }
    ];

    var schemas = [
      {},
      [],
      ['null', 'null'],
      ['null', {type: 'map', values: 'int'}, {type: 'map', values: 'long'}]
    ];

    testType(types.WrappedUnionType, data, schemas);

    test('instanceof Union', function () {
      var type = new types.WrappedUnionType(['null', 'int']);
      assert(type instanceof types.UnionType);
    });

    test('missing name write', function () {
      var type = new types.WrappedUnionType(['null', 'int']);
      assert.throws(function () {
        type.encode({b: 'a'}, {unsafe: true});
      }, AvscError);
    });

    test('read invalid index', function () {
      var type = new types.WrappedUnionType(['null', 'int']);
      var buf = new Buffer([1, 0]);
      assert.throws(function () { type.decode(buf); }, AvscError);
    });

    test('non wrapped write', function () {
      var type = new types.WrappedUnionType(['null', 'int']);
      assert.throws(function () {
        type.encode(1, {unsafe: true});
      }, AvscError);
    });

    test('to JSON', function () {
      var type = new types.WrappedUnionType(['null', 'int']);
      assert.equal(JSON.stringify(type), '["null","int"]');
    });

    test('adapt int to [long, int]', function () {
      var t1 = fromSchema('int');
      var t2 = fromSchema(['long', 'int']);
      var a = t2.createAdapter(t1);
      var buf = t1.encode(23);
      assert.deepEqual(t2.decode(buf, a), {'long': 23});
    });

    test('adapt null to [null, int]', function () {
      var t1 = fromSchema('null');
      var t2 = fromSchema(['null', 'int']);
      var a = t2.createAdapter(t1);
      assert.deepEqual(t2.decode(new Buffer(0), a), null);
    });

    test('adapt [string, int] to [long, string]', function () {
      var t1 = fromSchema(['string', 'int']);
      var t2 = fromSchema(['int', 'bytes']);
      var a = t2.createAdapter(t1);
      var buf;
      buf = t1.encode({string: 'hi'});
      assert.deepEqual(t2.decode(buf, a), {'bytes': new Buffer('hi')});
      buf = t1.encode({'int': 1});
      assert.deepEqual(t2.decode(buf, a), {'int': 1});
    });

  });

  suite('UnwrappedUnionType', function () {

    var data = [
      {
        name: 'null and string',
        schema: ['null', 'string'],
        valid: [null, 'hi'],
        invalid: [undefined, 2, {string: 1}],
        check: assert.deepEqual
      },
    ];

    var schemas = [
      [{type: 'array', items: 'int'}, {type: 'array', items: 'string'}]
    ];

    testType(types.UnwrappedUnionType, data, schemas);

    test('invalid write', function () {
      var type = new types.UnwrappedUnionType(['null', 'int']);
      assert.throws(function () {
        type.encode('a', {unsafe: true});
      }, AvscError);
    });

    test('instanceof Union', function () {
      var type = new types.UnwrappedUnionType(['null', 'int']);
      assert(type instanceof types.UnionType);
    });

    test('read invalid index', function () {
      var type = new types.UnwrappedUnionType(['null', 'int']);
      var buf = new Buffer([1, 0]);
      assert.throws(function () { type.decode(buf); }, AvscError);
    });

    test('to JSON', function () {
      var type = new types.UnwrappedUnionType(['null', 'int']);
      assert.equal(JSON.stringify(type), '["null","int"]');
    });

    test('adapt bytes to [bytes, string]', function () {
      var t1 = fromSchema('bytes', {unwrapUnions: true});
      var t2 = fromSchema(['bytes', 'string'], {unwrapUnions: true});
      var a = t2.createAdapter(t1);
      var buf = new Buffer('abc');
      assert.deepEqual(t2.decode(t1.encode(buf), a), buf);
    });

    test('adapt null to [string, null]', function () {
      var t1 = fromSchema('null');
      var t2 = fromSchema(['string', 'null']);
      var a = t2.createAdapter(t1);
      assert.deepEqual(t2.decode(new Buffer(0), a), null);
    });

    test('adapt [record, record] to record', function () {
      var t1 = fromSchema([
        {
          type: 'record',
          name: 'A',
          fields: [{name: 'a', type: 'int'}]
        },
        {
          type: 'record',
          name: 'B',
          fields: [{name: 'b', type: 'string'}]
        }
      ], {unwrapUnions: true});
      var t2 = fromSchema({
        type: 'record',
        name: 'AB',
        aliases: ['A', 'B'],
        fields: [
          {name: 'a', type: ['null', 'int'], 'default': null},
          {name: 'b', type: ['null', 'string'], 'default': null}
        ]
      }, {unwrapUnions: true});
      var a = t2.createAdapter(t1);
      var buf = t1.encode({a: 1});
      assert.deepEqual(t2.decode(buf, a), {a: 1, b: null});
      buf = t1.encode({b: 'hi'});
      assert.deepEqual(t2.decode(buf, a), {a: null, b: 'hi'});
    });

  });

  suite('RecordType', function () {

    var data = [
      {
        name: 'union field null and string with default',
        schema: {
          type: 'record',
          name: 'a',
          fields: [{name: 'b', type: ['null', 'string'], 'default': null}]
        },
        valid: [],
        invalid: [],
        check: assert.deepEqual
      }
    ];

    var schemas = [
      {type: 'record', name: 'a', fields: ['null', 'string']},
      {type: 'record', name: 'a', fields: [{type: ['null', 'string']}]},
      {
        type: 'record',
        name: 'a',
        fields: [{name: 'b', type: ['null', 'string'], 'default': 'a'}]
      },
      {type: 'record', name: 'a', fields: {type: 'int', name: 'age'}}
    ];

    testType(types.RecordType, data, schemas);

    test('duplicate field names', function () {
      assert.throws(function () {
        fromSchema({
          type: 'record',
          name: 'Person',
          fields: [{name: 'age', type: 'int'}, {name: 'age', type: 'float'}]
        });
      }, AvscError);
    });

    test('default constructor', function () {
      var type = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'age', type: 'int', 'default': 25}]
      });
      var Person = type.getRecordConstructor();
      var p = new Person();
      assert.equal(p.age, 25);
    });

    test('default check & write', function () {
      var type = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'age', type: 'int', 'default': 25}]
      });
      assert.deepEqual(type.encode({}), new Buffer([50]));
    });

    test('fixed string default', function () {
      var s = '\x01\x04';
      var b = new Buffer(s);
      var type = fromSchema({
        type: 'record',
        name: 'Object',
        fields: [
          {
            name: 'id',
            type: {type: 'fixed', size: 2, name: 'Id'},
            'default': s
          }
        ]
      });

      assert.deepEqual(type.fields[0]['default'], s);

      var obj = new (type.getRecordConstructor())();
      assert.deepEqual(obj.id, new Buffer([1, 4]));
      assert.deepEqual(type.encode({}), b);
    });

    test('fixed buffer default', function () {
      var s = '\x01\x04';
      var b = new Buffer(s);
      var type = fromSchema({
        type: 'record',
        name: 'Object',
        fields: [
          {
            name: 'id',
            type: {type: 'fixed', size: 2, name: 'Id'},
            'default': b
          }
        ]
      });
      assert.deepEqual(type.fields[0]['default'], s);
    });

    test('fixed buffer invalid default', function () {
      assert.throws(function () {
        fromSchema({
          type: 'record',
          name: 'Object',
          fields: [
            {
              name: 'id',
              type: {type: 'fixed', size: 2, name: 'Id'},
              'default': new Buffer([0])
            }
          ]
        });
      }, AvscError);
    });

    test('record isValid', function () {
      var type = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'age', type: 'int'}]
      });
      var Person = type.getRecordConstructor();
      assert((new Person(20)).$isValid());
      assert(!(new Person()).$isValid());
      assert(!(new Person('a')).$isValid());
    });

    test('record encode', function () {
      var type = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'age', type: 'int'}]
      });
      var Person = type.getRecordConstructor();
      assert.deepEqual((new Person(48)).$encode(), new Buffer([96]));
      assert.throws(function () { (new Person()).$encode(); });
      assert.doesNotThrow(function () {
        (new Person()).$encode({unsafe: true});
      });
    });

    test('Record decode', function () {
      var type = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'age', type: 'int'}]
      });
      var Person = type.getRecordConstructor();
      assert.deepEqual(Person.decode(new Buffer([40])), {age: 20});
    });

    test('Record random', function () {
      var type = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'age', type: 'int'}]
      });
      var Person = type.getRecordConstructor();
      assert(type.isValid(Person.random()));
    });

    test('mutable defaults', function () {
      var Person = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [
          {
            name: 'friends',
            type: {type: 'array', items: 'string'},
            'default': []
          }
        ]
      }).getRecordConstructor();
      var p1 = new Person(undefined);
      assert.deepEqual(p1.friends, []);
      p1.friends.push('ann');
      var p2 = new Person(undefined);
      assert.deepEqual(p2.friends, []);
    });

    test('adapt alias', function () {
      var v1 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'name', type: 'string'}]
      });
      var p = v1.random();
      var buf = v1.encode(p);
      var v2 = fromSchema({
        type: 'record',
        name: 'Human',
        aliases: ['Person'],
        fields: [{name: 'name', type: 'string'}]
      });
      var adapter = v2.createAdapter(v1);
      assert.deepEqual(v2.decode(buf, adapter), p);
      var v3 = fromSchema({
        type: 'record',
        name: 'Human',
        fields: [{name: 'name', type: 'string'}]
      });
      assert.throws(function () { v3.createAdapter(v1); }, AvscError);
    });

    test('adapt alias with namespace', function () {
      var v1 = fromSchema({
        type: 'record',
        name: 'Person',
        namespace: 'earth',
        fields: [{name: 'name', type: 'string'}]
      });
      var v2 = fromSchema({
        type: 'record',
        name: 'Human',
        aliases: ['Person'],
        fields: [{name: 'name', type: 'string'}]
      });
      assert.throws(function () { v2.createAdapter(v1); }, AvscError);
      var v3 = fromSchema({
        type: 'record',
        name: 'Human',
        aliases: ['earth.Person'],
        fields: [{name: 'name', type: 'string'}]
      });
      assert.doesNotThrow(function () { v3.createAdapter(v1); });
    });

    test('adapt skip field', function () {
      var v1 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [
          {name: 'age', type: 'int'},
          {name: 'name', type: 'string'}
        ]
      });
      var p = {age: 25, name: 'Ann'};
      var buf = v1.encode(p);
      var v2 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'name', type: 'string'}]
      });
      var adapter = v2.createAdapter(v1);
      assert.deepEqual(v2.decode(buf, adapter), {name: 'Ann'});
    });

    test('adapt new field', function () {
      var v1 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'name', type: 'string'}]
      });
      var p = {name: 'Ann'};
      var buf = v1.encode(p);
      var v2 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [
          {name: 'age', type: 'int', 'default': 25},
          {name: 'name', type: 'string'}
        ]
      });
      var adapter = v2.createAdapter(v1);
      assert.deepEqual(v2.decode(buf, adapter), {name: 'Ann', age: 25});
    });

    test('adapt new field no default', function () {
      var v1 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'name', type: 'string'}]
      });
      var v2 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [
          {name: 'age', type: 'int'},
          {name: 'name', type: 'string'}
        ]
      });
      assert.throws(function () { v2.createAdapter(v1); }, AvscError);
    });

    test('adapt from recursive schema', function () {
      var v1 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'friends', type: {type: 'array', items: 'Person'}}]
      });
      var v2 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'age', type: 'int', 'default': -1}]
      });
      var adapter = v2.createAdapter(v1);
      var p1 = {friends: [{friends: []}]};
      var p2 = v2.decode(v1.encode(p1), adapter);
      assert.deepEqual(p2, {age: -1});
    });

    test('adapt to recursive schema', function () {
      var v1 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'age', type: 'int', 'default': -1}]
      });
      var v2 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [
          {
            name: 'friends',
            type: {type: 'array', items: 'Person'},
            'default': []
          }
        ]
      });
      var adapter = v2.createAdapter(v1);
      var p1 = {age: 25};
      var p2 = v2.decode(v1.encode(p1), adapter);
      assert.deepEqual(p2, {friends: []});
    });

    test('adapt from both recursive schema', function () {
      var v1 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [
          {name: 'friends', type: {type: 'array', items: 'Person'}},
          {name: 'age', type: 'int'}
        ]
      });
      var v2 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'friends', type: {type: 'array', items: 'Person'}}]
      });
      var adapter = v2.createAdapter(v1);
      var p1 = {friends: [{age: 1, friends: []}], age: 10};
      var p2 = v2.decode(v1.encode(p1), adapter);
      assert.deepEqual(p2, {friends: [{friends: []}]});
    });

    test('adapt multiple matching aliases', function () {
      var v1 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [
          {name: 'phone', type: 'string'},
          {name: 'number', type: 'string'}
        ]
      });
      var v2 = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'number', type: 'string', aliases: ['phone']}]
      });
      assert.throws(function () { v2.createAdapter(v1); }, AvscError);
    });

  });

  suite('adapt unions', function () {

    test('to valid union', function () {
      var t1 = fromSchema(['int', 'string']);
      var t2 = fromSchema(['null', 'string', 'long']);
      var adapter = t2.createAdapter(t1);
      var buf = t1.encode({'int': 12});
      assert.deepEqual(t2.decode(buf, adapter), {'long': 12});
    });

    test('to invalid union', function () {
      var t1 = fromSchema(['int', 'string']);
      var t2 = fromSchema(['null', 'long']);
      assert.throws(function () { t2.createAdapter(t1); }, AvscError);
    });

    test('to non union', function () {
      var t1 = fromSchema(['int', 'long']);
      var t2 = fromSchema('long');
      var adapter = t2.createAdapter(t1);
      var buf = t1.encode({'int': 12});
      assert.equal(t2.decode(buf, adapter), 12);
      buf = new Buffer([4, 0]);
      assert.throws(function () { t2.decode(buf, adapter); }, AvscError);
    });

    test('to invalid non union', function () {
      var t1 = fromSchema(['int', 'long']);
      var t2 = fromSchema('int');
      assert.throws(function() { t2.createAdapter(t1); }, AvscError);
    });

  });

  suite('type names', function () {

    test('existing', function () {
      var type = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [{name: 'so', type: 'Person'}]
      });
      assert.strictEqual(type, type.fields[0].type);
    });

    test('namespaced', function () {
      var type = fromSchema({
        type: 'record',
        name: 'Person',
        fields: [
          {
            name: 'so',
            type: {
              type: 'record',
              name: 'Person',
              fields: [{name: 'age', type: 'int'}],
              namespace: 'a'
            }
          }
        ]
      });
      assert.equal(type.name, 'Person');
      assert.equal(type.fields[0].type.name, 'a.Person');
    });

    test('redefining', function () {
      assert.throws(function () {
        fromSchema({
          type: 'record',
          name: 'Person',
          fields: [
            {
              name: 'so',
              type: {
                type: 'record',
                name: 'Person',
                fields: [{name: 'age', type: 'int'}]
              }
            }
          ]
        });
      }, AvscError);
    });

    test('missing', function () {
      assert.throws(function () {
        fromSchema({
          type: 'record',
          name: 'Person',
          fields: [{name: 'so', type: 'Friend'}]
        });
      }, AvscError);
    });

    test('redefining primitive', function () {
      assert.throws( // Unqualified.
        function () { fromSchema({type: 'fixed', name: 'int', size: 2}); },
        AvscError
      );
      assert.throws( // Qualified.
        function () {
          fromSchema({type: 'fixed', name: 'int', size: 2, namespace: 'a'});
        },
        AvscError
      );
    });

    test('aliases', function () {
      var type = fromSchema({
        type: 'record',
        name: 'Person',
        namespace: 'a',
        aliases: ['Human', 'b.Being'],
        fields: [{name: 'age', type: 'int'}]
      });
      assert.deepEqual(type.aliases, ['a.Human', 'b.Being']);
    });

  });

});

function testType(Type, data, invalidSchemas) {

  data.forEach(function (elem) {
    test(elem.name || elem.schema, function () {
      var type = new Type(elem.schema);
      elem.valid.forEach(function (v) {
        assert(type.isValid(v), '' + v);
        var fn = elem.check || assert.deepEqual;
        fn(type.decode(type.encode(v)), v);
      });
      elem.invalid.forEach(function (v) {
        assert(!type.isValid(v), '' + v);
      });
      assert(type.isValid(type.random()));
    });
  });

  test('skip', function () {
    data.forEach(function (elem) {
      var fn = elem.check || assert.deepEqual;
      var items = elem.valid;
      if (items.length > 1) {
        var type = new Type(elem.schema);
        var buf = new Buffer(1024);
        var tap = new Tap(buf);
        type._write.call(tap, items[0]);
        type._write.call(tap, items[1]);
        tap.pos = 0;
        type._skip.call(tap);
        fn(type._read.call(tap), items[1]);
      }
    });
  });

  test('invalid', function () {
    invalidSchemas.forEach(function (schema) {
      assert.throws(function () { new Type(schema); }, AvscError);
    });
  });

}

function getAdapter(reader, writer) {

  return fromSchema(reader).createAdapter(fromSchema(writer));

}

function floatEquals(a, b) {

  return Math.abs((a - b) / Math.min(a, b)) < 1e-7;

}
