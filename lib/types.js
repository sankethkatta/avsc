/* jshint node: true */

'use strict';

// TODO: Add `equals` (and `compare`?) method to each type.
// TODO: Add regex check for valid type and field names.
// TODO: Support JS keywords as record field names (e.g. `null`).
// TODO: Add logging using `debuglog` to help identify schema parsing errors.
// TODO: Enable recursive schema JSON serialization without a replacer.
// TODO: Implement `clone` method.
// TODO: Implememt `toString` method on types which returns canonical string.

var Tap = require('./tap'),
    utils = require('./utils'),
    buffer = require('buffer'), // For `SlowBuffer`.
    util = require('util');


// Avro primitive types.
var PRIMITIVES = [
  'null',
  'boolean',
  'int',
  'long',
  'float',
  'double',
  'bytes',
  'string'
];

// Random generator.
var RANDOM = new utils.Lcg();

// Allowed schema promotions.
var PROMOTIONS = {
  'int': ['long', 'float', 'double'],
  'long': ['float', 'double'],
  'float': ['double'],
  'string': ['bytes'],
  'bytes': ['string']
};

// Valid (field, type, and symbol) name regex.
var NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Custom error class, imported for convenience.
var AvscError = utils.AvscError;


/**
 * "Abstract" base Avro type class.
 *
 */
function Type(type) { this.type = type; }

/**
 * Create a registry with all the Avro primitive types defined.
 *
 * This function can be used for example to prime a custom registry to pass in
 * to `Type.fromSchema`.
 *
 */
Type.createRegistry = function () {
  var registry = {};
  var i, l, name;
  for (i = 0, l = PRIMITIVES.length; i < l; i++) {
    name = PRIMITIVES[i];
    registry[name] = new PrimitiveType(name);
  }
  return registry;
};

/**
 * Parse a schema and return the corresponding type.
 *
 * See `index.js` for option documentation.
 *
 */
Type.fromSchema = function (schema, opts) {
  opts = getOpts(schema, opts);

  var type;

  if (typeof schema == 'string') { // Type reference.
    if (
      opts.namespace &&
      !~schema.indexOf('.') &&
      !~PRIMITIVES.indexOf(schema) // Primitives can't be namespaced.
    ) {
      schema = opts.namespace + '.' + schema;
    }
    type = opts.registry[schema];
    if (type) {
      return type;
    }
    throw new AvscError('missing name: %s', schema);
  }

  type = (function (wrap) {
    // jshint -W056
    if (schema instanceof Array) {
      return new (wrap ? WrappedUnionType : UnwrappedUnionType)(schema, opts);
    }
    switch (schema.type) {
      case 'null':
      case 'boolean':
      case 'int':
      case 'long':
      case 'float':
      case 'double':
      case 'bytes':
      case 'string':
        return new PrimitiveType(schema.type);
        // We create new primitives here to make type hooks more useful
        // (otherwise it wouldn't be possible to make modification to just one
        // primitive). Primitives referred to by name are still shared though
        // (the most common case).
      case 'array':
        return new ArrayType(schema, opts);
      case 'enum':
        return new EnumType(schema, opts);
      case 'fixed':
        return new FixedType(schema, opts);
      case 'map':
        return new MapType(schema, opts);
      case 'record':
        return new RecordType(schema, opts);
      default:
        throw new AvscError('unknown type: %j', schema.type);
    }
  })(!opts.unwrapUnions);

  if (opts.typeHook) {
    opts.typeHook.call(type, schema);
  }
  return type;
};

/**
 * Base decoding method.
 *
 * This method should always be called with a tap as context. For example:
 * `type._read.call(tap)`. It is also important to remember to check that the
 * tap is valid after a read.
 *
 */
Type.prototype._read = utils.abstractFunction;

/**
 * Skip reading a type.
 *
 */
Type.prototype._skip = utils.abstractFunction;

/**
 * Encode a type instance.
 *
 * @param obj {Object} The object to encode.
 *
 * Similarly to `_read` above, this method should be called with a tap as
 * context: `type._write.call(tap, obj)`. The tap should be checked for
 * validity afterwards as well.
 *
 */
Type.prototype._write = utils.abstractFunction;

/**
 * Generate an adapter for the given type.
 *
 * @param type {Type} Writer type.
 * @param opts {Object} Options:
 *
 *  + `registry` {Object}
 *
 * This method should not be called directly! It is called internally by
 * `createAdapter`, which handles things like unions properly. For convenience,
 * `createAdapter` will also raise an error if `_createAdapter` returns a
 * false-ish value.
 *
 */
Type.prototype._createAdapter = utils.abstractFunction;

/**
 * Check that the object can be encoded by this type.
 *
 * @param obj {Object} The object to check.
 *
 */
Type.prototype.isValid = utils.abstractFunction;

/**
 * Generate a random instance of this type.
 *
 */
Type.prototype.random = utils.abstractFunction;

/**
 * Adapt a schema to read data serialized by another type.
 *
 * @param type {Type} Writer type.
 * @param opts {Object} Options. Available keys:
 *
 *  + `registry`, Dictionary of already generated adapters. This is required to
 *    support some recursive schemas.
 *
 * Throws an error if incompatible.
 *
 */
Type.prototype.createAdapter = function (type, opts) {
  opts = opts || {};
  opts.registry = opts.registry || {};

  var adapter, key;
  if (this.type === 'record' && type.type === 'record') {
    key = this.name + ':' + type.name; // ':' is illegal in Avro type names.
    adapter = opts.registry[key];
    if (adapter) {
      return adapter;
    }
  }

  adapter = new Adapter(this, type);

  if (key) { // Register adapter early for recursive schemas.
    opts.registry[key] = adapter;
  }

  if (type instanceof UnionType) {
    var adapters = type.types.map(function (t) {
      return this.createAdapter(t, opts);
    }, this);
    adapter._read = function () {
      var index = this.readLong();
      var adapter = adapters[index];
      if (adapter === undefined) {
        throw new AvscError('invalid union index: %s', index);
      }
      return adapter._read.call(this);
    };
  } else {
    adapter._read = this._createAdapter(type, opts);
  }

  if (!adapter._read) {
    throw new AvscError('incompatible types: %j %j', this, type);
  }
  return adapter;
};

/**
 * Decode Avro bytes.
 *
 * @param buf {Buffer} Avro representation of an object.
 * @param adapter {Adapter} Optional reader to decode records serialized from
 * another schema. See `createAdapter` for details.
 *
 * Note: preliminary testing showed that reusing instances brings no
 * significant benefit (it doesn't appear cheaper than creating new objects).
 *
 */
Type.prototype.decode = function (buf, adapter) {
  var tap = new Tap(buf);
  var reader;
  if (adapter) {
    if (adapter._readerType !== this) {
      throw new AvscError('invalid adapter');
    }
    reader = adapter._read;
  } else {
    reader = this._read;
  }
  var obj = reader.call(tap, true); // Enable lazy reading.
  if (!tap.isValid()) {
    throw new AvscError('truncated buffer');
  }
  return obj;
};

/**
 * Encode object.
 *
 * @param obj {Object} The object to encode. Depending on the type, it can be a
 * number, a string, an array, or an object.
 * @param opts {Object} Optional encoding options:
 *
 *  + `size`, initial size of the encoding buffer. If it is too small to hold
 *    the entire object, a resize will be necessary. Defaults to 1024.
 *  + `unsafe`, bypass validity checks. Encoding an invalid object is undefined
 *    behavior (e.g. it might throw an error, or fail silently).
 *
 */
Type.prototype.encode = function (obj, opts) {
  if ((!opts || !opts.unsafe) && !this.isValid(obj)) {
    throw new AvscError('invalid %j: %j', this, obj);
  }

  var tap = new Tap(new Buffer((opts && opts.size) || 1024));
  this._write.call(tap, obj);
  if (!tap.isValid()) {
    // We overflowed the buffer, need to resize.
    tap.buf = new Buffer(tap.pos);
    tap.pos = 0;
    this._write.call(tap, obj);
  }

  return tap.buf.slice(0, tap.pos);
};

// Implementations.

/**
 * Primitive Avro types.
 *
 * These are grouped together and all instances are typically shared across a
 * single schema (since the default registry defines their name).
 *
 */
function PrimitiveType(name) {
  Type.call(this, name);
  var s = utils.capitalize(name);
  this._read = Tap.prototype['read' + s];
  this._skip = Tap.prototype['skip' + s];
  this._write = Tap.prototype['write' + s];

  switch (name) {
    case 'null':
      this.isValid = function (o) { return o === null; };
      this.random = function () { return null; };
      break;
    case 'boolean':
      this.isValid = function (o) { /* jshint -W018 */ return o === !!o; };
      this.random = function () { return RANDOM.nextBoolean(); };
      break;
    case 'int':
      this.isValid = function (o) { return o === (o | 0); };
      this.random = function () { return RANDOM.nextInt(1000) | 0; };
      break;
    case 'long':
      this.isValid = function (o) {
        return typeof o == 'number' &&
          o % 1 === 0 &&
          o <= Number.MAX_SAFE_INTEGER &&
          o >= Number.MIN_SAFE_INTEGER; // Can't capture full range sadly.
      };
      this.random = function () { return RANDOM.nextInt(); };
      break;
    case 'float':
      this.isValid = function (o) {
        return typeof o == 'number' && Math.abs(o) < 3.4028234e38;
      };
      this.random = function () { return RANDOM.nextFloat(1e3); };
      break;
    case 'double':
      this.isValid = function (o) { return typeof o == 'number'; };
      this.random = function () { return RANDOM.nextFloat(); };
      break;
    case 'string':
      this.isValid = function (o) { return typeof o == 'string'; };
      this.random = function () {
        return RANDOM.nextString(RANDOM.nextInt(32));
      };
      break;
    case 'bytes':
      this.isValid = Buffer.isBuffer;
      this.random = function () {
        return RANDOM.nextBuffer(RANDOM.nextInt(32));
      };
      break;
    default:
      throw new AvscError('invalid primitive type: %j', name);
  }
}
util.inherits(PrimitiveType, Type);

PrimitiveType.prototype._createAdapter = function (type) {
  var name = this.type;
  if (
    type instanceof PrimitiveType &&
    (type.type === name || utils.contains(PROMOTIONS[type.type], name))
  ) {
    return this._read;
  }
};

PrimitiveType.prototype.toJSON = function () { return this.type; };


/**
 * Abstract base Avro union type.
 *
 * There are two types below:
 *
 *  + Wrapped in a single entry map (defined by the Avro specification). This
 *    makes encoding unambiguous but is overkill in most cases.
 *  + Unwrapped, which is simpler and slightly faster.
 *
 */
function UnionType(schema, opts) {
  if (!(schema instanceof Array)) {
    throw new AvscError('non-array union schema: %j', schema);
  }
  if (!schema.length) {
    throw new AvscError('empty union');
  }

  opts = getOpts(schema, opts);

  Type.call(this, 'union');
  this.types = schema.map(function (o) { return Type.fromSchema(o, opts); });
}
util.inherits(UnionType, Type);

UnionType.prototype.toJSON = function () { return this.types; };


function WrappedUnionType(schema, opts) {
  UnionType.call(this, schema, opts);

  var longReader = Tap.prototype.readLong;
  var longWriter = Tap.prototype.writeLong;
  var readers = this.types.map(function (type) { return type._read; });
  var skippers = this.types.map(function (type) { return type._skip; });
  var writers = this.types.map(function (type) { return type._write; });
  var indices = {};
  var i, l, type, name;
  for (i = 0, l = this.types.length; i < l; i++) {
    type = this.types[i];
    name = type.name || type.type;
    if (indices[name] !== undefined) {
      throw new AvscError('duplicate union name: %j', name);
    }
    indices[name] = i;
  }

  var constructors = this.types.map(function (type) {
    // jshint -W054
    var name = type.name || type.type;
    if (name === 'null') {
      return null;
    }
    var body;
    if (~name.indexOf('.')) { // Qualified name.
      body = 'this[\'' + name + '\'] = obj;';
    } else {
      body = 'this.' + name + ' = obj;';
    }
    return new Function('obj', body);
  });

  this._read = function () {
    var index = longReader.call(this);
    var Class = constructors[index];
    if (Class) {
      return new Class(readers[index].call(this));
    } else if (Class === null) {
      return null;
    } else {
      throw new AvscError('invalid union index: %s', index);
    }
  };

  this._skip = function () { skippers[longReader.call(this)].call(this); };

  this._write = function (obj) {
    if (typeof obj != 'object') {
      throw new AvscError('invalid union: ' + obj);
    }
    var name = obj === null ? 'null' : Object.keys(obj)[0];
    var index = indices[name];
    if (index === undefined) {
      throw new AvscError('no such name in union: ' + name);
    }
    longWriter.call(this, index);
    if (obj !== null) {
      writers[index].call(this, obj[name]);
    }
  };

  this._createAdapter = function (type, opts) {

    // jshint -W083
    // (The loop exits after the first function is created.)

    var i, l, adapter, Class;
    for (i = 0, l = this.types.length; i < l; i++) {
      try {
        adapter = this.types[i].createAdapter(type, opts);
      } catch (err) {
        continue;
      }
      Class = constructors[i];
      if (Class) {
        return function () { return new Class(adapter._read.call(this)); };
      } else {
        return function () { return null; };
      }
    }

  };

  this.isValid = function (obj) {
    if (typeof obj != 'object') {
      return false;
    }
    if (obj === null) {
      return indices['null'] !== undefined;
    }
    var name = Object.keys(obj)[0];
    var index = indices[name];
    if (index === undefined) {
      return false;
    }
    return this.types[index].isValid(obj[name]);
  };

  this.random = function () {
    var index = RANDOM.nextInt(this.types.length);
    var Class = constructors[index];
    if (!Class) {
      return null;
    }
    return new Class(this.types[index].random());
  };
}
util.inherits(WrappedUnionType, UnionType);


function UnwrappedUnionType(schema, opts) {
  UnionType.call(this, schema, opts);

  var self = this;
  var longReader = Tap.prototype.readLong;
  var longWriter = Tap.prototype.writeLong;
  var readers = this.types.map(function (type) { return type._read; });
  var skippers = this.types.map(function (type) { return type._skip; });
  var indices = {};
  var i, l, type, name;
  for (i = 0, l = this.types.length; i < l; i++) {
    type = this.types[i];
    name = type.name || type.type;
    if (indices[name] !== undefined) {
      throw new AvscError('duplicate union name: %j', name);
    }
    indices[name] = i;
  }

  this._read = function () {
    var index = longReader.call(this);
    var reader = readers[index];
    if (reader === undefined) {
      throw new AvscError('invalid union index: %s', index);
    }
    return reader.call(this);
  };

  this._skip = function () { skippers[longReader.call(this)].call(this); };

  this._write = function (obj) {
    var i, l, type;
    for (i = 0, l = self.types.length; i < l; i++) {
      type = self.types[i];
      if (type.isValid(obj)) {
        longWriter.call(this, i);
        type._write.call(this, obj);
        return;
      }
    }
    throw new AvscError('invalid union value: ' + obj);
  };
}
util.inherits(UnwrappedUnionType, UnionType);

UnwrappedUnionType.prototype._createAdapter = function (type, opts) {
  // jshint -W083
  // (The loop exits after the first function is created.)

  var i, l, adapter;
  for (i = 0, l = this.types.length; i < l; i++) {
    try {
      adapter = this.types[i].createAdapter(type, opts);
    } catch (err) {
      continue;
    }
    // We don't return `adapter._read` directly because this property might not
    // be available yet.
    return function () { return adapter._read.call(this); };
  }
};

UnwrappedUnionType.prototype.isValid = function (obj) {
  return this.types.some(function (type) { return type.isValid(obj); });
};

UnwrappedUnionType.prototype.random = function () {
  return RANDOM.choice(this.types).random();
};


/**
 * Avro enum type.
 *
 */
function EnumType(schema, opts) {
  if (!(schema.symbols instanceof Array) || !schema.symbols.length) {
    throw new AvscError('invalid %j enum symbols: %j', schema.name, schema);
  }

  opts = getOpts(schema, opts);

  var self = this;
  var resolutions = resolveNames(schema, opts.namespace);
  var reader = Tap.prototype.readLong;
  var writer = Tap.prototype.writeLong;
  var indices = {};
  var i, l, symbol;
  for (i = 0, l = schema.symbols.length; i < l; i++) {
    symbol = schema.symbols[i];
    indices[symbol] = i;
    if (!NAME_PATTERN.test(symbol)) {
      throw new AvscError('invalid symbol name: %s', symbol);
    }
  }

  Type.call(this, 'enum');
  this.doc = schema.doc;
  this.symbols = schema.symbols;
  this.aliases = resolutions.aliases;
  this.name = resolutions.name;
  registerType(this, opts.registry);

  this._read = function () {
    var index = reader.call(this);
    var symbol = self.symbols[index];
    if (symbol === undefined) {
      throw new AvscError('invalid %s enum index: %s', self.name, index);
    }
    return symbol;
  };

  this._skip = Tap.prototype.skipLong;

  this._write = function (s) {
    var index = indices[s];
    if (index === undefined) {
      throw new AvscError('invalid %s enum value: %j', self.name, s);
    }
    writer.call(this, index);
  };

  this.isValid = function (s) {
    return typeof s == 'string' && indices[s] !== undefined;
  };
}
util.inherits(EnumType, Type);

EnumType.prototype.random = function () {
  return RANDOM.choice(this.symbols);
};

EnumType.prototype._createAdapter = function (type) {
  var symbols = this.symbols;
  if (
    type instanceof EnumType &&
    this.size === type.size &&
    ~getAliases(this).indexOf(type.name) &&
    type.symbols.every(function (s) { return ~symbols.indexOf(s); })
  ) {
    return type._read;
  }
};


/**
 * Avro fixed type.
 *
 */
function FixedType(schema, opts) {
  if (schema.size !== (schema.size | 0) || schema.size < 1) {
    throw new AvscError('invalid %j fixed size: %j', schema.name, schema.size);
  }

  opts = getOpts(schema, opts);

  var self = this;
  var resolutions = resolveNames(schema, opts.namespace);
  var reader = Tap.prototype.readFixed;
  var skipper = Tap.prototype.skipFixed;
  var writer = Tap.prototype.writeFixed;

  Type.call(this, 'fixed');
  this.size = schema.size;
  this.aliases = resolutions.aliases;
  this.name = resolutions.name;
  registerType(this, opts.registry);

  this._read = function () { return reader.call(this, self.size); };

  this._skip = function () { skipper.call(this, self.size); };

  this._write = function (buf) { writer.call(this, buf, self.size); };

  this.isValid = function (buf) {
    return Buffer.isBuffer(buf) && buf.length == self.size;
  };
}
util.inherits(FixedType, Type);

FixedType.prototype.random = function () {
  return RANDOM.nextBuffer(this.size);
};

FixedType.prototype._createAdapter = function (type) {
  if (
    type instanceof FixedType &&
    this.size === type.size &&
    ~getAliases(this).indexOf(type.name)
  ) {
    return this._read;
  }
};


/**
 * Avro map.
 *
 */
function MapType(schema, opts) {
  if (!schema.values) {
    throw new AvscError('missing map values: %j', schema);
  }

  opts = getOpts(schema, opts);

  Type.call(this, 'map');
  this.values = Type.fromSchema(schema.values, opts);

  var values = this.values;
  var reader = Tap.prototype.readMap;
  var skipper = Tap.prototype.skipMap;
  var writer = Tap.prototype.writeMap;

  this._read = function () { return reader.call(this, values._read); };

  this._skip = function () { skipper.call(this, values._skip); };

  this._write = function (obj) { writer.call(this, obj, values._write); };
}
util.inherits(MapType, Type);

MapType.prototype.isValid = function (obj) {
  if (typeof obj != 'object' || obj instanceof Array) {
    return false;
  }
  var keys = Object.keys(obj);
  var i, l;
  for (i = 0, l = keys.length; i < l; i++) {
    if (!this.values.isValid(obj[keys[i]])) {
      return false;
    }
  }
  return true;
};

MapType.prototype.random = function () {
  var obj = {};
  var i, l;
  for (i = 0, l = RANDOM.nextInt(10); i < l; i++) {
    obj[RANDOM.nextString(RANDOM.nextInt(20))] = this.values.random();
  }
  return obj;
};

MapType.prototype._createAdapter = function (type, opts) {
  if (type instanceof MapType) {
    var reader = Tap.prototype.readMap;
    var adapter = this.values.createAdapter(type.values, opts);
    return function () { return reader.call(this, adapter._read); };
  }
};


/**
 * Avro array.
 *
 */
function ArrayType(schema, opts) {
  if (!schema.items) {
    throw new AvscError('missing array items: %j', schema);
  }

  opts = getOpts(schema, opts);

  Type.call(this, 'array');
  this.items = Type.fromSchema(schema.items, opts);

  var items = this.items;
  var reader = Tap.prototype.readArray;
  var skipper = Tap.prototype.skipArray;
  var writer = Tap.prototype.writeArray;

  this._read = function () { return reader.call(this, items._read); };

  this._skip = function () { return skipper.call(this, items._skip); };

  this._write = function (arr) { writer.call(this, arr, items._write); };
}
util.inherits(ArrayType, Type);

ArrayType.prototype.isValid = function (obj) {
  if (!(obj instanceof Array)) {
    return false;
  }
  var itemsType = this.items;
  return obj.every(function (elem) { return itemsType.isValid(elem); });
};

ArrayType.prototype.random = function () {
  var arr = [];
  var i, l;
  for (i = 0, l = RANDOM.nextInt(10); i < l; i++) {
    arr.push(this.items.random());
  }
  return arr;
};

ArrayType.prototype._createAdapter = function (type, opts) {
  if (type instanceof ArrayType) {
    var reader = Tap.prototype.readArray;
    var adapter = this.items.createAdapter(type.items, opts);
    return function () { return reader.call(this, adapter._read); };
  }
};


/**
 * Avro record.
 *
 * A "specific record class" gets programmatically created for each record.
 * This gives significant speedups over using generics objects (~3 times
 * faster) and provides a custom constructor.
 *
 */
function RecordType(schema, opts) {
  opts = getOpts(schema, opts);

  var resolutions = resolveNames(schema, opts.namespace);

  Type.call(this, 'record');
  this.doc = schema.doc;
  this.aliases = resolutions.aliases;
  this.name = resolutions.name;
  registerType(this, opts.registry);

  if (!(schema.fields instanceof Array)) {
    throw new AvscError('non-array %s fields', this.name);
  }
  if (utils.hasDuplicates(schema.fields, function (f) { return f.name; })) {
    throw new AvscError('duplicate %s field name', this.name);
  }
  this.fields = schema.fields.map(function (field) {
    var name = field.name;
    if (typeof name != 'string' || !NAME_PATTERN.test(name)) {
      throw new AvscError('invalid field name: %s', name);
    }
    var type = Type.fromSchema(field.type, opts);
    var value = field['default'];
    var getDefault;
    if (value !== undefined) {
      if (~['fixed', 'bytes'].indexOf(type.type)) {
        if (Buffer.isBuffer(value)) {
          // In case the default was instantiated programmatically. We set it
          // back on the field so that JSON serialization works as expected.
          value = field['default'] = value.toString('binary');
        }
        // Buffers are mutable (and can't be frozen), so we must create a new
        // instance each time.
        getDefault = function () { return new Buffer(value, 'binary'); };
      } else if (~PRIMITIVES.indexOf(type.type)) {
        // These defaults are immutable, so we can safely just return them.
        getDefault = function () { return value; };
      } else {
        // We must perform a copy each time.
        value = JSON.stringify(value);
        getDefault = function () { return JSON.parse(value); };
      }
      // Avro forces the default value to be of the first type in the
      // enum, so we must do a bit of extra logic here.
      if (
        !(type.type === 'union' ? type.types[0] : type).isValid(getDefault())
      ) {
        throw new AvscError(
          'invalid default for %s\'s %s field: %j',
          this.name, name, value
        );
      }
    }
    return {
      name: name,
      aliases: field.aliases,
      doc: field.doc,
      type: type,
      'default': field['default'], // For JSON serialization.
      _getDefault: getDefault // For JS objects.
    };
  }, this);

  this._construct = this._createConstructor();

  this._read = this._createReader(this);

  this._skip = this._createSkipper();

  this._write = this._createWriter();

  this.isValid = this._createChecker();
}
util.inherits(RecordType, Type);

RecordType.prototype.random = function () {
  // jshint -W058

  var fields = [undefined];
  var i, l;
  for (i = 0, l = this.fields.length; i < l; i++) {
    fields.push(this.fields[i].type.random());
  }
  return new (this._construct.bind.apply(this._construct, fields));
};

RecordType.prototype.getRecordConstructor = function () {
  return this._construct;
};

RecordType.prototype._createConstructor = function () {
  // jshint -W054

  var outerArgs = [];
  var innerArgs = [];
  var innerBody = '';
  var ds = []; // Defaults.
  var i, l, field, name, getDefault;
  for (i = 0, l = this.fields.length; i < l; i++) {
    field = this.fields[i];
    getDefault = field._getDefault;
    name = field.name;
    innerArgs.push(name);
    innerBody += '  ';
    if (getDefault === undefined) {
      innerBody += 'this.' + name + ' = ' + name + ';\n';
    } else {
      innerBody += 'if (' + name + ' === undefined) { ';
      innerBody += 'this.' + name + ' = d' + ds.length + '(); ';
      innerBody += '} else { this.' + name + ' = ' + name + '; }\n';
      outerArgs.push('d' + ds.length);
      ds.push(getDefault);
      // TODO: Optimize away function call for immutable defaults.
    }
  }
  var outerBody = 'return function ' + unqualify(this.name) + '(';
  outerBody += innerArgs.join() + ') {\n' + innerBody + '};';
  var Record = new Function(outerArgs.join(), outerBody).apply(undefined, ds);

  var self = this;
  Record.decode = function (o, adapter) { return self.decode(o, adapter); };
  Record.random = function () { return self.random(); };
  Record.prototype = {
    $type: this,
    $encode: function (opts) { return self.encode(this, opts); },
    $isValid: function () { return self.isValid(this); }
  };
  // The names of these properties added to the prototype are prefixed with `$`
  // because it is an invalid property name in Avro but not in JavaScript.
  // (This way we are guaranteed not to be stepped over!)

  return Record;
};

RecordType.prototype._createReader = function () {
  // jshint -W054

  var uname = unqualify(this.name);
  var names = [];
  var values = [this._construct];
  var i, l;
  for (i = 0, l = this.fields.length; i < l; i++) {
    names.push('t' + i);
    values.push(this.fields[i].type);
  }
  var body = 'return function read' + uname + '() {\n';
  body += '  return new ' + uname + '(';
  body += names.map(function (t) { return t + '._read.call(this)'; }).join();
  body += ');\n};';
  names.unshift(uname);
  // We can do this since the JS spec guarantees that function arguments are
  // evaluated from left to right.
  return new Function(names.join(), body).apply(undefined, values);
};

RecordType.prototype._createSkipper = function () {
  // jshint -W054

  var args = [];
  var body = 'return function skip' + unqualify(this.name) + '() {\n';
  var values = [];
  var i, l;
  for (i = 0, l = this.fields.length; i < l; i++) {
    args.push('t' + i);
    values.push(this.fields[i].type);
    body += '  t' + i + '._skip.call(this);\n';
  }
  body += '}';
  return new Function(args.join(), body).apply(undefined, values);
};

RecordType.prototype._createWriter = function () {
  // jshint -W054

  // We still do default handling here, in case a normal JS object is passed.

  var args = [];
  var body = 'return function write' + unqualify(this.name) + '(obj) {\n';
  var values = [];
  var i, l, field, defaultValue;
  for (i = 0, l = this.fields.length; i < l; i++) {
    field = this.fields[i];
    args.push('t' + i);
    values.push(field.type);
    body += '  ';
    if (field._getDefault === undefined) {
      body += 't' + i + '._write.call(this, obj.' + field.name + ');\n';
    } else {
      defaultValue = field._getDefault();
      // We use the default's value directly since it will be stored in the
      // writer's closure and won't be available to be modified.
      if (Buffer.isBuffer(defaultValue)) {
        // We don't want to hold on to whole buffer slabs because of this
        // though, so we copy them to standalone buffers.
        defaultValue = new buffer.SlowBuffer(defaultValue.length);
        field._getDefault().copy(defaultValue);
      }
      args.push('d' + i);
      values.push(defaultValue);
      body += 'var v' + i + ' = obj.' + field.name + '; ';
      body += 'if (v' + i + ' === undefined) { ';
      body += 'v' + i + ' = d' + i + ';';
      body += ' } t' + i + '._write.call(this, v' + i + ');\n';
    }
  }
  body += '}';
  return new Function(args.join(), body).apply(undefined, values);
};

RecordType.prototype._createChecker = function () {
  // jshint -W054

  var names = [];
  var values = [];
  var body = 'return function check' + unqualify(this.name) + '(obj) {\n';
  body += '  if (typeof obj != \'object\') { return false; }\n';
  var i, l, field;
  for (i = 0, l = this.fields.length; i < l; i++) {
    field = this.fields[i];
    names.push('t' + i);
    values.push(field.type);
    body += '  ';
    if (field._getDefault === undefined) {
      body += 'if (!t' + i + '.isValid(obj.' + field.name + ')) { ';
      body += 'return false; }\n';
    } else {
      body += 'var v' + i + ' = obj.' + field.name + '; ';
      body += 'if (v' + i + ' !== undefined && ';
      body += '!t' + i + '.isValid(v' + i + ')) { ';
      body += 'return false; }\n';
    }
  }
  body += '  return true;\n};';
  return new Function(names.join(), body).apply(undefined, values);
};

RecordType.prototype._createAdapter = function (type, opts) {
  // jshint -W054

  if (!~getAliases(this).indexOf(type.name)) {
    throw new AvscError('no alias for %s in %s', type.name, this.name);
  }

  var rFields = this.fields;
  var wFields = type.fields;
  var wFieldsMap = utils.toMap(wFields, function (f) { return f.name; });

  var innerArgs = []; // Arguments for reader constructor.
  var adapters = {}; // Adapters keyed by writer field name.
  var i, j, field, name, names, matches;
  for (i = 0; i < rFields.length; i++) {
    field = rFields[i];
    names = getAliases(field);
    matches = [];
    for (j = 0; j < names.length; j++) {
      name = names[j];
      if (wFieldsMap[name]) {
        matches.push(name);
      }
    }
    if (matches.length > 1) {
      throw new AvscError('multiple matches for %s', field.name);
    }
    if (!matches.length) {
      if (field['default'] === undefined) {
        throw new AvscError('no match for default-less %s', field.name);
      }
      innerArgs.push('undefined');
    } else {
      name = matches[0];
      adapters[name] = {
        adapter: field.type.createAdapter(wFieldsMap[name].type, opts),
        name: field.name // Reader field name.
      };
      innerArgs.push(field.name);
    }
  }

  // See if we can add a bypass for unused fields at the end of the record.
  var lazyIndex = -1;
  i = wFields.length;
  while (i && adapters[wFields[--i].name] === undefined) {
    lazyIndex = i;
  }

  var uname = unqualify(this.name);
  var args = [uname];
  var values = [this._construct];
  var body = '  return function read' + uname + '(lazy) {\n';
  for (i = 0; i < wFields.length; i++) {
    if (i === lazyIndex) {
      body += '  if (!lazy) {\n';
    }
    field = type.fields[i];
    name = field.name;
    body += i >= lazyIndex ? '    ' : '  ';
    if (adapters[name] === undefined) {
      args.push('t' + i);
      values.push(field.type);
      body += 't' + i + '._skip.call(this);\n';
    } else {
      args.push('t' + i);
      values.push(adapters[name].adapter);
      body += 'var ' + adapters[name].name + ' = ';
      body += 't' + i + '._read.call(this);\n';
    }
  }
  if (~lazyIndex) {
    body += '  }\n';
  }
  body +=  '  return new ' + uname + '(' + innerArgs.join() + ');\n};';
  return new Function(args.join(), body).apply(undefined, values);
};

// General helpers.

/**
 * Adapter to read a writer's schema as a new schema.
 *
 */
function Adapter(readerType, writerType) {
  this._readerType = readerType;
  this._writerType = writerType; // Not used currently.
  this._read = null; // Added afterwards (late binding to support recursion).
}

/**
 * Create default parsing options.
 *
 * @param opts {Object} Base options.
 *
 */
function getOpts(schema, opts) {
  opts = opts || {};
  opts.registry = opts.registry || Type.createRegistry();
  opts.namespace = schema.namespace || opts.namespace;
  return opts;
}

/**
 * Resolve a schema's name and aliases.
 *
 * @param schema {Object} True schema (can't be a string).
 * @param namespace {String} Optional parent namespace.
 *
 */
function resolveNames(schema, namespace) {
  namespace = schema.namespace || namespace;

  var name = schema.name;
  if (!name) {
    throw new AvscError('no name in schema: %j', schema);
  }
  var resolutions = {name: resolve(name)};
  if (schema.aliases) {
    resolutions.aliases = schema.aliases.map(resolve);
  }
  return resolutions;

  function resolve(name) {
    if (!~name.indexOf('.') && namespace) {
      name = namespace + '.' + name;
    }
    var tail = unqualify(name);
    if (~PRIMITIVES.indexOf(tail)) {
      throw new AvscError('cannot rename: %s', tail);
    }
    return name;

  }
}

/**
 * Remove namespace from a name.
 *
 * @param name {String} Full or short name.
 *
 */
function unqualify(name) {
  var parts = name.split('.');
  return parts[parts.length - 1];
}

/**
 * Get all aliases for a type (including its name).
 *
 * @param obj {Type|Object} Typically a type or a field.
 *
 */
function getAliases(obj) {
  var names = [obj.name];
  var aliases = obj.aliases;
  var i, l;
  if (aliases) {
    for (i = 0, l = aliases.length; i < l; i++) {
      names.push(aliases[i]);
    }
  }
  return names;
}

/**
 * Register a type using its name.
 *
 * @param type {Type} The type to register. This must be a "named" type (one of
 * fixed, enum, or record). Its name must already have been resolved.
 * @param registry {Object} Where to store the types.
 *
 * Registering the name name multiple times for a different type will raise an
 * error. Note also that aliases aren't registered (aliases are only used when
 * adapting a reader's schema).
 *
 */
function registerType(type, registry) {
  var name = type.name;
  var prev = registry[name];
  if (prev !== undefined && prev !== type) {
    throw new AvscError('duplicate type name: %s', name);
  }
  registry[name] = type;
}


module.exports = {
  ArrayType: ArrayType,
  EnumType: EnumType,
  FixedType: FixedType,
  MapType: MapType,
  PrimitiveType: PrimitiveType,
  RecordType: RecordType,
  Type: Type,
  UnionType: UnionType,
  UnwrappedUnionType: UnwrappedUnionType,
  WrappedUnionType: WrappedUnionType
};
