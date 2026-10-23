/* DMP web (MIT), Miracle 2024; luaparse (MIT). See licenses/. */
(()=>{
const luaparse=(()=>{const module={exports:{}};const exports=module.exports;
/* global exports:true, module:true, require:true, define:true, global:true */

(function (root, name, factory) {
  'use strict';

  // Used to determine if values are of the language type `Object`
  var objectTypes = {
        'function': true
      , 'object': true
    }
    // Detect free variable `exports`
    , freeExports = objectTypes[typeof exports] && exports && !exports.nodeType && exports
    // Detect free variable `module`
    , freeModule = objectTypes[typeof module] && module && !module.nodeType && module
    // Detect free variable `global`, from Node.js or Browserified code, and
    // use it as `window`
    , freeGlobal = freeExports && freeModule && typeof global === 'object' && global
    // Detect the popular CommonJS extension `module.exports`
    , moduleExports = freeModule && freeModule.exports === freeExports && freeExports;

  /* istanbul ignore else */
  if (freeGlobal && (freeGlobal.global === freeGlobal ||
                     /* istanbul ignore next */ freeGlobal.window === freeGlobal ||
                     /* istanbul ignore next */ freeGlobal.self === freeGlobal)) {
    root = freeGlobal;
  }

  // Some AMD build optimizers, like r.js, check for specific condition
  // patterns like the following:
  /* istanbul ignore if */
  if (typeof define === 'function' &&
      /* istanbul ignore next */ typeof define.amd === 'object' &&
      /* istanbul ignore next */ define.amd) {
    // defined as an anonymous module.
    define(['exports'], factory);
    // In case the source has been processed and wrapped in a define module use
    // the supplied `exports` object.
    if (freeExports && moduleExports) factory(freeModule.exports);
  }
  // check for `exports` after `define` in case a build optimizer adds an
  // `exports` object
  else /* istanbul ignore else */ if (freeExports && freeModule) {
    // in Node.js or RingoJS v0.8.0+
    /* istanbul ignore else */
    if (moduleExports) factory(freeModule.exports);
    // in RingoJS v0.7.0-
    else factory(freeExports);
  }
  // in a browser or Rhino
  else {
    factory((root[name] = {}));
  }
}(this, 'luaparse', function (exports) {
  'use strict';

  exports.version = "0.3.1";

  var input, options, length, features, encodingMode;

  // Options can be set either globally on the parser object through
  // defaultOptions, or during the parse call.
  var defaultOptions = exports.defaultOptions = {
    // Explicitly tell the parser when the input ends.
      wait: false
    // Store comments as an array in the chunk object.
    , comments: true
    // Track identifier scopes by adding an isLocal attribute to each
    // identifier-node.
    , scope: false
    // Store location information on each syntax node as
    // `loc: { start: { line, column }, end: { line, column } }`.
    , locations: false
    // Store the start and end character locations on each syntax node as
    // `range: [start, end]`.
    , ranges: false
    // A callback which will be invoked when a syntax node has been completed.
    // The node which has been created will be passed as the only parameter.
    , onCreateNode: null
    // A callback which will be invoked when a new scope is created.
    , onCreateScope: null
    // A callback which will be invoked when the current scope is destroyed.
    , onDestroyScope: null
    // A callback which will be invoked when a local variable is declared in the current scope.
    // The variable's name will be passed as the only parameter
    , onLocalDeclaration: null
    // The version of Lua targeted by the parser (string; allowed values are
    // '5.1', '5.2', '5.3').
    , luaVersion: '5.1'
    // Encoding mode: how to interpret code units higher than U+007F in input
    , encodingMode: 'none'
  };

  function encodeUTF8(codepoint, highMask) {
    highMask = highMask || 0;

    if (codepoint < 0x80) {
      return String.fromCharCode(codepoint);
    } else if (codepoint < 0x800) {
      return String.fromCharCode(
        highMask | 0xc0 |  (codepoint >>  6)        ,
        highMask | 0x80 | ( codepoint        & 0x3f)
      );
    } else if (codepoint < 0x10000) {
      return String.fromCharCode(
        highMask | 0xe0 |  (codepoint >> 12)        ,
        highMask | 0x80 | ((codepoint >>  6) & 0x3f),
        highMask | 0x80 | ( codepoint        & 0x3f)
      );
    } else /* istanbul ignore else */ if (codepoint < 0x110000) {
      return String.fromCharCode(
        highMask | 0xf0 |  (codepoint >> 18)        ,
        highMask | 0x80 | ((codepoint >> 12) & 0x3f),
        highMask | 0x80 | ((codepoint >>  6) & 0x3f),
        highMask | 0x80 | ( codepoint        & 0x3f)
      );
    } else {
      // TODO: Lua 5.4 allows up to six-byte sequences, as in UTF-8:1993
      return null;
    }
  }

  function toHex(num, digits) {
    var result = num.toString(16);
    while (result.length < digits)
      result = '0' + result;
    return result;
  }

  function checkChars(rx) {
    return function (s) {
      var m = rx.exec(s);
      if (!m)
        return s;
      raise(null, errors.invalidCodeUnit, toHex(m[0].charCodeAt(0), 4).toUpperCase());
    };
  }

  var encodingModes = {
    // `pseudo-latin1` encoding mode: assume the input was decoded with the latin1 encoding
    // WARNING: latin1 does **NOT** mean cp1252 here like in the bone-headed WHATWG standard;
    // it means true ISO/IEC 8859-1 identity-mapped to Basic Latin and Latin-1 Supplement blocks
    'pseudo-latin1': {
      fixup: checkChars(/[^\x00-\xff]/),
      encodeByte: function (value) {
        if (value === null)
          return '';
        return String.fromCharCode(value);
      },
      encodeUTF8: function (codepoint) {
        return encodeUTF8(codepoint);
      },
    },

    // `x-user-defined` encoding mode: assume the input was decoded with the WHATWG `x-user-defined` encoding
    'x-user-defined': {
      fixup: checkChars(/[^\x00-\x7f\uf780-\uf7ff]/),
      encodeByte: function (value) {
        if (value === null)
          return '';
        if (value >= 0x80)
          return String.fromCharCode(value | 0xf700);
        return String.fromCharCode(value);
      },
      encodeUTF8: function (codepoint) {
        return encodeUTF8(codepoint, 0xf700);
      }
    },

    // `none` encoding mode: disregard intrepretation of string literals, leave identifiers as-is
    'none': {
      discardStrings: true,
      fixup: function (s) {
        return s;
      },
      encodeByte: function (value) {
        return '';
      },
      encodeUTF8: function (codepoint) {
        return '';
      }
    }
  };

  // The available tokens expressed as enum flags so they can be checked with
  // bitwise operations.

  var EOF = 1, StringLiteral = 2, Keyword = 4, Identifier = 8
    , NumericLiteral = 16, Punctuator = 32, BooleanLiteral = 64
    , NilLiteral = 128, VarargLiteral = 256;

  exports.tokenTypes = { EOF: EOF, StringLiteral: StringLiteral
    , Keyword: Keyword, Identifier: Identifier, NumericLiteral: NumericLiteral
    , Punctuator: Punctuator, BooleanLiteral: BooleanLiteral
    , NilLiteral: NilLiteral, VarargLiteral: VarargLiteral
  };

  // As this parser is a bit different from luas own, the error messages
  // will be different in some situations.

  var errors = exports.errors = {
      unexpected: 'unexpected %1 \'%2\' near \'%3\''
    , unexpectedEOF: 'unexpected symbol near \'<eof>\''
    , expected: '\'%1\' expected near \'%2\''
    , expectedToken: '%1 expected near \'%2\''
    , unfinishedString: 'unfinished string near \'%1\''
    , malformedNumber: 'malformed number near \'%1\''
    , decimalEscapeTooLarge: 'decimal escape too large near \'%1\''
    , invalidEscape: 'invalid escape sequence near \'%1\''
    , hexadecimalDigitExpected: 'hexadecimal digit expected near \'%1\''
    , braceExpected: 'missing \'%1\' near \'%2\''
    , tooLargeCodepoint: 'UTF-8 value too large near \'%1\''
    , unfinishedLongString: 'unfinished long string (starting at line %1) near \'%2\''
    , unfinishedLongComment: 'unfinished long comment (starting at line %1) near \'%2\''
    , ambiguousSyntax: 'ambiguous syntax (function call x new statement) near \'%1\''
    , noLoopToBreak: 'no loop to break near \'%1\''
    , labelAlreadyDefined: 'label \'%1\' already defined on line %2'
    , labelNotVisible: 'no visible label \'%1\' for <goto>'
    , gotoJumpInLocalScope: '<goto %1> jumps into the scope of local \'%2\''
    , cannotUseVararg: 'cannot use \'...\' outside a vararg function near \'%1\''
    , invalidCodeUnit: 'code unit U+%1 is not allowed in the current encoding mode'
  };

  // ### Abstract Syntax Tree
  //
  // The default AST structure is inspired by the Mozilla Parser API but can
  // easily be customized by overriding these functions.

  var ast = exports.ast = {
      labelStatement: function(label) {
      return {
          type: 'LabelStatement'
        , label: label
      };
    }

    , breakStatement: function() {
      return {
          type: 'BreakStatement'
      };
    }

    , gotoStatement: function(label) {
      return {
          type: 'GotoStatement'
        , label: label
      };
    }

    , returnStatement: function(args) {
      return {
          type: 'ReturnStatement'
        , 'arguments': args
      };
    }

    , ifStatement: function(clauses) {
      return {
          type: 'IfStatement'
        , clauses: clauses
      };
    }
    , ifClause: function(condition, body) {
      return {
          type: 'IfClause'
        , condition: condition
        , body: body
      };
    }
    , elseifClause: function(condition, body) {
      return {
          type: 'ElseifClause'
        , condition: condition
        , body: body
      };
    }
    , elseClause: function(body) {
      return {
          type: 'ElseClause'
        , body: body
      };
    }

    , whileStatement: function(condition, body) {
      return {
          type: 'WhileStatement'
        , condition: condition
        , body: body
      };
    }

    , doStatement: function(body) {
      return {
          type: 'DoStatement'
        , body: body
      };
    }

    , repeatStatement: function(condition, body) {
      return {
          type: 'RepeatStatement'
        , condition: condition
        , body: body
      };
    }

    , localStatement: function(variables, init) {
      return {
          type: 'LocalStatement'
        , variables: variables
        , init: init
      };
    }

    , assignmentStatement: function(variables, init) {
      return {
          type: 'AssignmentStatement'
        , variables: variables
        , init: init
      };
    }

    , callStatement: function(expression) {
      return {
          type: 'CallStatement'
        , expression: expression
      };
    }

    , functionStatement: function(identifier, parameters, isLocal, body) {
      return {
          type: 'FunctionDeclaration'
        , identifier: identifier
        , isLocal: isLocal
        , parameters: parameters
        , body: body
      };
    }

    , forNumericStatement: function(variable, start, end, step, body) {
      return {
          type: 'ForNumericStatement'
        , variable: variable
        , start: start
        , end: end
        , step: step
        , body: body
      };
    }

    , forGenericStatement: function(variables, iterators, body) {
      return {
          type: 'ForGenericStatement'
        , variables: variables
        , iterators: iterators
        , body: body
      };
    }

    , chunk: function(body) {
      return {
          type: 'Chunk'
        , body: body
      };
    }

    , identifier: function(name) {
      return {
          type: 'Identifier'
        , name: name
      };
    }

    , literal: function(type, value, raw) {
      type = (type === StringLiteral) ? 'StringLiteral'
        : (type === NumericLiteral) ? 'NumericLiteral'
        : (type === BooleanLiteral) ? 'BooleanLiteral'
        : (type === NilLiteral) ? 'NilLiteral'
        : 'VarargLiteral';

      return {
          type: type
        , value: value
        , raw: raw
      };
    }

    , tableKey: function(key, value) {
      return {
          type: 'TableKey'
        , key: key
        , value: value
      };
    }
    , tableKeyString: function(key, value) {
      return {
          type: 'TableKeyString'
        , key: key
        , value: value
      };
    }
    , tableValue: function(value) {
      return {
          type: 'TableValue'
        , value: value
      };
    }


    , tableConstructorExpression: function(fields) {
      return {
          type: 'TableConstructorExpression'
        , fields: fields
      };
    }
    , binaryExpression: function(operator, left, right) {
      var type = ('and' === operator || 'or' === operator) ?
        'LogicalExpression' :
        'BinaryExpression';

      return {
          type: type
        , operator: operator
        , left: left
        , right: right
      };
    }
    , unaryExpression: function(operator, argument) {
      return {
          type: 'UnaryExpression'
        , operator: operator
        , argument: argument
      };
    }
    , memberExpression: function(base, indexer, identifier) {
      return {
          type: 'MemberExpression'
        , indexer: indexer
        , identifier: identifier
        , base: base
      };
    }

    , indexExpression: function(base, index) {
      return {
          type: 'IndexExpression'
        , base: base
        , index: index
      };
    }

    , callExpression: function(base, args) {
      return {
          type: 'CallExpression'
        , base: base
        , 'arguments': args
      };
    }

    , tableCallExpression: function(base, args) {
      return {
          type: 'TableCallExpression'
        , base: base
        , 'arguments': args
      };
    }

    , stringCallExpression: function(base, argument) {
      return {
          type: 'StringCallExpression'
        , base: base
        , argument: argument
      };
    }

    , comment: function(value, raw) {
      return {
          type: 'Comment'
        , value: value
        , raw: raw
      };
    }
  };

  // Wrap up the node object.

  function finishNode(node) {
    // Pop a `Marker` off the location-array and attach its location data.
    if (trackLocations) {
      var location = locations.pop();
      location.complete();
      location.bless(node);
    }
    if (options.onCreateNode) options.onCreateNode(node);
    return node;
  }


  // Helpers
  // -------

  var slice = Array.prototype.slice
    , toString = Object.prototype.toString
    ;

  var indexOf = /* istanbul ignore next */ function (array, element) {
    for (var i = 0, length = array.length; i < length; ++i) {
      if (array[i] === element) return i;
    }
    return -1;
  };

  /* istanbul ignore else */
  if (Array.prototype.indexOf)
    indexOf = function (array, element) {
      return array.indexOf(element);
    };

  // Iterate through an array of objects and return the index of an object
  // with a matching property.

  function indexOfObject(array, property, element) {
    for (var i = 0, length = array.length; i < length; ++i) {
      if (array[i][property] === element) return i;
    }
    return -1;
  }

  // A sprintf implementation using %index (beginning at 1) to input
  // arguments in the format string.
  //
  // Example:
  //
  //     // Unexpected function in token
  //     sprintf('Unexpected %2 in %1.', 'token', 'function');

  function sprintf(format) {
    var args = slice.call(arguments, 1);
    format = format.replace(/%(\d)/g, function (match, index) {
      return '' + args[index - 1] || /* istanbul ignore next */ '';
    });
    return format;
  }

  // Polyfill for `Object.assign`.

  var assign = /* istanbul ignore next */ function (dest) {
    var args = slice.call(arguments, 1)
      , src, prop;

    for (var i = 0, length = args.length; i < length; ++i) {
      src = args[i];
      for (prop in src)
        /* istanbul ignore else */
        if (Object.prototype.hasOwnProperty.call(src, prop)) {
          dest[prop] = src[prop];
        }
    }

    return dest;
  };

  /* istanbul ignore else */
  if (Object.assign)
    assign = Object.assign;

  // ### Error functions

  exports.SyntaxError = SyntaxError;

  // XXX: Eliminate this function and change the error type to be different from SyntaxError.
  // This will unfortunately be a breaking change, because some downstream users depend
  // on the error thrown being an instance of SyntaxError. For example, the Ace editor:
  // <https://github.com/ajaxorg/ace/blob/4c7e5eb3f5d5ca9434847be51834a4e41661b852/lib/ace/mode/lua_worker.js#L55>

  function fixupError(e) {
    /* istanbul ignore if */
    if (!Object.create)
      return e;
    return Object.create(e, {
      'line': { 'writable': true, value: e.line },
      'index': { 'writable': true, value: e.index },
      'column': { 'writable': true, value: e.column }
    });
  }

  // #### Raise an exception.
  //
  // Raise an exception by passing a token, a string format and its paramters.
  //
  // The passed tokens location will automatically be added to the error
  // message if it exists, if not it will default to the lexers current
  // position.
  //
  // Example:
  //
  //     // [1:0] expected [ near (
  //     raise(token, "expected %1 near %2", '[', token.value);

  function raise(token) {
    var message = sprintf.apply(null, slice.call(arguments, 1))
      , error, col;

    if (token === null || typeof token.line === 'undefined') {
      col = index - lineStart + 1;
      error = fixupError(new SyntaxError(sprintf('[%1:%2] %3', line, col, message)));
      error.index = index;
      error.line = line;
      error.column = col;
    } else {
      col = token.range[0] - token.lineStart;
      error = fixupError(new SyntaxError(sprintf('[%1:%2] %3', token.line, col, message)));
      error.line = token.line;
      error.index = token.range[0];
      error.column = col;
    }
    throw error;
  }

  function tokenValue(token) {
    var raw = input.slice(token.range[0], token.range[1]);
    if (raw)
      return raw;
    return token.value;
  }

  // #### Raise an unexpected token error.
  //
  // Example:
  //
  //     // expected <name> near '0'
  //     raiseUnexpectedToken('<name>', token);

  function raiseUnexpectedToken(type, token) {
    raise(token, errors.expectedToken, type, tokenValue(token));
  }

  // #### Raise a general unexpected error
  //
  // Usage should pass either a token object or a symbol string which was
  // expected. We can also specify a nearby token such as <eof>, this will
  // default to the currently active token.
  //
  // Example:
  //
  //     // Unexpected symbol 'end' near '<eof>'
  //     unexpected(token);
  //
  // If there's no token in the buffer it means we have reached <eof>.

  function unexpected(found) {
    var near = tokenValue(lookahead);
    if ('undefined' !== typeof found.type) {
      var type;
      switch (found.type) {
        case StringLiteral:   type = 'string';      break;
        case Keyword:         type = 'keyword';     break;
        case Identifier:      type = 'identifier';  break;
        case NumericLiteral:  type = 'number';      break;
        case Punctuator:      type = 'symbol';      break;
        case BooleanLiteral:  type = 'boolean';     break;
        case NilLiteral:
          return raise(found, errors.unexpected, 'symbol', 'nil', near);
        case EOF:
          return raise(found, errors.unexpectedEOF);
      }
      return raise(found, errors.unexpected, type, tokenValue(found), near);
    }
    return raise(found, errors.unexpected, 'symbol', found, near);
  }

  // Lexer
  // -----
  //
  // The lexer, or the tokenizer reads the input string character by character
  // and derives a token left-right. To be as efficient as possible the lexer
  // prioritizes the common cases such as identifiers. It also works with
  // character codes instead of characters as string comparisons was the
  // biggest bottleneck of the parser.
  //
  // If `options.comments` is enabled, all comments encountered will be stored
  // in an array which later will be appended to the chunk object. If disabled,
  // they will simply be disregarded.
  //
  // When the lexer has derived a valid token, it will be returned as an object
  // containing its value and as well as its position in the input string (this
  // is always enabled to provide proper debug messages).
  //
  // `lex()` starts lexing and returns the following token in the stream.

  var index
    , token
    , previousToken
    , lookahead
    , comments
    , tokenStart
    , line
    , lineStart;

  exports.lex = lex;

  function lex() {
    skipWhiteSpace();

    // Skip comments beginning with --
    while (45 === input.charCodeAt(index) &&
           45 === input.charCodeAt(index + 1)) {
      scanComment();
      skipWhiteSpace();
    }
    if (index >= length) return {
        type : EOF
      , value: '<eof>'
      , line: line
      , lineStart: lineStart
      , range: [index, index]
    };

    var charCode = input.charCodeAt(index)
      , next = input.charCodeAt(index + 1);

    // Memorize the range index where the token begins.
    tokenStart = index;
    if (isIdentifierStart(charCode)) return scanIdentifierOrKeyword();

    switch (charCode) {
      case 39: case 34: // '"
        return scanStringLiteral();

      case 48: case 49: case 50: case 51: case 52: case 53:
      case 54: case 55: case 56: case 57: // 0-9
        return scanNumericLiteral();

      case 46: // .
        // If the dot is followed by a digit it's a float.
        if (isDecDigit(next)) return scanNumericLiteral();
        if (46 === next) {
          if (46 === input.charCodeAt(index + 2)) return scanVarargLiteral();
          return scanPunctuator('..');
        }
        return scanPunctuator('.');

      case 61: // =
        if (61 === next) return scanPunctuator('==');
        return scanPunctuator('=');

      case 62: // >
        if (features.bitwiseOperators)
          if (62 === next) return scanPunctuator('>>');
        if (61 === next) return scanPunctuator('>=');
        return scanPunctuator('>');

      case 60: // <
        if (features.bitwiseOperators)
          if (60 === next) return scanPunctuator('<<');
        if (61 === next) return scanPunctuator('<=');
        return scanPunctuator('<');

      case 126: // ~
        if (61 === next) return scanPunctuator('~=');
        if (!features.bitwiseOperators)
          break;
        return scanPunctuator('~');

      case 58: // :
        if (features.labels)
          if (58 === next) return scanPunctuator('::');
        return scanPunctuator(':');

      case 91: // [
        // Check for a multiline string, they begin with [= or [[
        if (91 === next || 61 === next) return scanLongStringLiteral();
        return scanPunctuator('[');

      case 47: // /
        // Check for integer division op (//)
        if (features.integerDivision)
          if (47 === next) return scanPunctuator('//');
        return scanPunctuator('/');

      case 38: case 124: // & |
        if (!features.bitwiseOperators)
          break;

        /* fall through */
      case 42: case 94: case 37: case 44: case 123: case 125:
      case 93: case 40: case 41: case 59: case 35: case 45:
      case 43: // * ^ % , { } ] ( ) ; # - +
        return scanPunctuator(input.charAt(index));
    }

    return unexpected(input.charAt(index));
  }

  // Whitespace has no semantic meaning in lua so simply skip ahead while
  // tracking the encounted newlines. Any kind of eol sequence is counted as a
  // single line.

  function consumeEOL() {
    var charCode = input.charCodeAt(index)
      , peekCharCode = input.charCodeAt(index + 1);

    if (isLineTerminator(charCode)) {
      // Count \n\r and \r\n as one newline.
      if (10 === charCode && 13 === peekCharCode) ++index;
      if (13 === charCode && 10 === peekCharCode) ++index;
      ++line;
      lineStart = ++index;

      return true;
    }
    return false;
  }

  function skipWhiteSpace() {
    while (index < length) {
      var charCode = input.charCodeAt(index);
      if (isWhiteSpace(charCode)) {
        ++index;
      } else if (!consumeEOL()) {
        break;
      }
    }
  }

  // Identifiers, keywords, booleans and nil all look the same syntax wise. We
  // simply go through them one by one and defaulting to an identifier if no
  // previous case matched.

  function scanIdentifierOrKeyword() {
    var value, type;

    // Slicing the input string is prefered before string concatenation in a
    // loop for performance reasons.
    while (isIdentifierPart(input.charCodeAt(++index)));
    value = encodingMode.fixup(input.slice(tokenStart, index));

    // Decide on the token type and possibly cast the value.
    if (isKeyword(value)) {
      type = Keyword;
    } else if ('true' === value || 'false' === value) {
      type = BooleanLiteral;
      value = ('true' === value);
    } else if ('nil' === value) {
      type = NilLiteral;
      value = null;
    } else {
      type = Identifier;
    }

    return {
        type: type
      , value: value
      , line: line
      , lineStart: lineStart
      , range: [tokenStart, index]
    };
  }

  // Once a punctuator reaches this function it should already have been
  // validated so we simply return it as a token.

  function scanPunctuator(value) {
    index += value.length;
    return {
        type: Punctuator
      , value: value
      , line: line
      , lineStart: lineStart
      , range: [tokenStart, index]
    };
  }

  // A vararg literal consists of three dots.

  function scanVarargLiteral() {
    index += 3;
    return {
        type: VarargLiteral
      , value: '...'
      , line: line
      , lineStart: lineStart
      , range: [tokenStart, index]
    };
  }

  // Find the string literal by matching the delimiter marks used.

  function scanStringLiteral() {
    var delimiter = input.charCodeAt(index++)
      , beginLine = line
      , beginLineStart = lineStart
      , stringStart = index
      , string = encodingMode.discardStrings ? null : ''
      , charCode;

    for (;;) {
      charCode = input.charCodeAt(index++);
      if (delimiter === charCode) break;
      // EOF or `\n` terminates a string literal. If we haven't found the
      // ending delimiter by now, raise an exception.
      if (index > length || isLineTerminator(charCode)) {
        string += input.slice(stringStart, index - 1);
        raise(null, errors.unfinishedString, input.slice(tokenStart, index - 1));
      }
      if (92 === charCode) { // backslash
        if (!encodingMode.discardStrings) {
          var beforeEscape = input.slice(stringStart, index - 1);
          string += encodingMode.fixup(beforeEscape);
        }
        var escapeValue = readEscapeSequence();
        if (!encodingMode.discardStrings)
          string += escapeValue;
        stringStart = index;
      }
    }
    if (!encodingMode.discardStrings) {
      string += encodingMode.encodeByte(null);
      string += encodingMode.fixup(input.slice(stringStart, index - 1));
    }

    return {
        type: StringLiteral
      , value: string
      , line: beginLine
      , lineStart: beginLineStart
      , lastLine: line
      , lastLineStart: lineStart
      , range: [tokenStart, index]
    };
  }

  // Expect a multiline string literal and return it as a regular string
  // literal, if it doesn't validate into a valid multiline string, throw an
  // exception.

  function scanLongStringLiteral() {
    var beginLine = line
      , beginLineStart = lineStart
      , string = readLongString(false);
    // Fail if it's not a multiline literal.
    if (false === string) raise(token, errors.expected, '[', tokenValue(token));

    return {
        type: StringLiteral
      , value: encodingMode.discardStrings ? null : encodingMode.fixup(string)
      , line: beginLine
      , lineStart: beginLineStart
      , lastLine: line
      , lastLineStart: lineStart
      , range: [tokenStart, index]
    };
  }

  // Numeric literals will be returned as floating-point numbers instead of
  // strings. The raw value should be retrieved from slicing the input string
  // later on in the process.
  //
  // If a hexadecimal number is encountered, it will be converted.

  function scanNumericLiteral() {
    var character = input.charAt(index)
      , next = input.charAt(index + 1);

    var literal = ('0' === character && 'xX'.indexOf(next || null) >= 0) ?
      readHexLiteral() : readDecLiteral();

    var foundImaginaryUnit = readImaginaryUnitSuffix()
      , foundInt64Suffix = readInt64Suffix();

    if (foundInt64Suffix && (foundImaginaryUnit || literal.hasFractionPart)) {
      raise(null, errors.malformedNumber, input.slice(tokenStart, index));
    }

    return {
        type: NumericLiteral
      , value: literal.value
      , line: line
      , lineStart: lineStart
      , range: [tokenStart, index]
    };
  }

  function readImaginaryUnitSuffix() {
    if (!features.imaginaryNumbers) return;

    // Imaginary unit number suffix is optional.
    // See http://luajit.org/ext_ffi_api.html#literals
    if ('iI'.indexOf(input.charAt(index) || null) >= 0) {
      ++index;
      return true;
    } else {
      return false;
    }
  }

  function readInt64Suffix() {
    if (!features.integerSuffixes) return;

    // Int64/uint64 number suffix is optional.
    // See http://luajit.org/ext_ffi_api.html#literals

    if ('uU'.indexOf(input.charAt(index) || null) >= 0) {
      ++index;
      if ('lL'.indexOf(input.charAt(index) || null) >= 0) {
        ++index;
        if ('lL'.indexOf(input.charAt(index) || null) >= 0) {
          ++index;
          return 'ULL';
        } else {
          // UL but no L
          raise(null, errors.malformedNumber, input.slice(tokenStart, index));
        }
      } else {
        // U but no L
        raise(null, errors.malformedNumber, input.slice(tokenStart, index));
      }
    } else if ('lL'.indexOf(input.charAt(index) || null) >= 0) {
        ++index;
        if ('lL'.indexOf(input.charAt(index) || null) >= 0) {
          ++index;
          return 'LL';
        } else {
          // First L but no second L
          raise(null, errors.malformedNumber, input.slice(tokenStart, index));
        }
    }
  }

  // Lua hexadecimals have an optional fraction part and an optional binary
  // exoponent part. These are not included in JavaScript so we will compute
  // all three parts separately and then sum them up at the end of the function
  // with the following algorithm.
  //
  //     Digit := toDec(digit)
  //     Fraction := toDec(fraction) / 16 ^ fractionCount
  //     BinaryExp := 2 ^ binaryExp
  //     Number := ( Digit + Fraction ) * BinaryExp

  function readHexLiteral() {
    var fraction = 0 // defaults to 0 as it gets summed
      , binaryExponent = 1 // defaults to 1 as it gets multiplied
      , binarySign = 1 // positive
      , digit, fractionStart, exponentStart, digitStart;

    digitStart = index += 2; // Skip 0x part

    // A minimum of one hex digit is required.
    if (!isHexDigit(input.charCodeAt(index)))
      raise(null, errors.malformedNumber, input.slice(tokenStart, index));

    while (isHexDigit(input.charCodeAt(index))) ++index;
    // Convert the hexadecimal digit to base 10.
    digit = parseInt(input.slice(digitStart, index), 16);

    // Fraction part is optional.
    var foundFraction = false;
    if ('.' === input.charAt(index)) {
      foundFraction = true;
      fractionStart = ++index;

      while (isHexDigit(input.charCodeAt(index))) ++index;
      fraction = input.slice(fractionStart, index);

      // Empty fraction parts should default to 0, others should be converted
      // 0.x form so we can use summation at the end.
      fraction = (fractionStart === index) ? 0
        : parseInt(fraction, 16) / Math.pow(16, index - fractionStart);
    }

    // Binary exponents are optional
    var foundBinaryExponent = false;
    if ('pP'.indexOf(input.charAt(index) || null) >= 0) {
      foundBinaryExponent = true;
      ++index;

      // Sign part is optional and defaults to 1 (positive).
      if ('+-'.indexOf(input.charAt(index) || null) >= 0)
        binarySign = ('+' === input.charAt(index++)) ? 1 : -1;

      exponentStart = index;

      // The binary exponent sign requires a decimal digit.
      if (!isDecDigit(input.charCodeAt(index)))
        raise(null, errors.malformedNumber, input.slice(tokenStart, index));

      while (isDecDigit(input.charCodeAt(index))) ++index;
      binaryExponent = input.slice(exponentStart, index);

      // Calculate the binary exponent of the number.
      binaryExponent = Math.pow(2, binaryExponent * binarySign);
    }

    return {
      value: (digit + fraction) * binaryExponent,
      hasFractionPart: foundFraction || foundBinaryExponent
    };
  }

  // Decimal numbers are exactly the same in Lua and in JavaScript, because of
  // this we check where the token ends and then parse it with native
  // functions.

  function readDecLiteral() {
    while (isDecDigit(input.charCodeAt(index))) ++index;
    // Fraction part is optional
    var foundFraction = false;
    if ('.' === input.charAt(index)) {
      foundFraction = true;
      ++index;
      // Fraction part defaults to 0
      while (isDecDigit(input.charCodeAt(index))) ++index;
    }

    // Exponent part is optional.
    var foundExponent = false;
    if ('eE'.indexOf(input.charAt(index) || null) >= 0) {
      foundExponent = true;
      ++index;
      // Sign part is optional.
      if ('+-'.indexOf(input.charAt(index) || null) >= 0) ++index;
      // An exponent is required to contain at least one decimal digit.
      if (!isDecDigit(input.charCodeAt(index)))
        raise(null, errors.malformedNumber, input.slice(tokenStart, index));

      while (isDecDigit(input.charCodeAt(index))) ++index;
    }

    return {
      value: parseFloat(input.slice(tokenStart, index)),
      hasFractionPart: foundFraction || foundExponent
    };
  }

  function readUnicodeEscapeSequence() {
    var sequenceStart = index++;

    if (input.charAt(index++) !== '{')
      raise(null, errors.braceExpected, '{', '\\' + input.slice(sequenceStart, index));
    if (!isHexDigit(input.charCodeAt(index)))
      raise(null, errors.hexadecimalDigitExpected, '\\' + input.slice(sequenceStart, index));

    while (input.charCodeAt(index) === 0x30) ++index;
    var escStart = index;

    while (isHexDigit(input.charCodeAt(index))) {
      ++index;
      if (index - escStart > 6)
        raise(null, errors.tooLargeCodepoint, '\\' + input.slice(sequenceStart, index));
    }

    var b = input.charAt(index++);
    if (b !== '}') {
      if ((b === '"') || (b === "'"))
        raise(null, errors.braceExpected, '}', '\\' + input.slice(sequenceStart, index--));
      else
        raise(null, errors.hexadecimalDigitExpected, '\\' + input.slice(sequenceStart, index));
    }

    var codepoint = parseInt(input.slice(escStart, index - 1) || '0', 16);
    var frag = '\\' + input.slice(sequenceStart, index);

    if (codepoint > 0x10ffff) {
      raise(null, errors.tooLargeCodepoint, frag);
    }

    return encodingMode.encodeUTF8(codepoint, frag);
  }

  // Translate escape sequences to the actual characters.
  function readEscapeSequence() {
    var sequenceStart = index;
    switch (input.charAt(index)) {
      // Lua allow the following escape sequences.
      case 'a': ++index; return '\x07';
      case 'n': ++index; return '\n';
      case 'r': ++index; return '\r';
      case 't': ++index; return '\t';
      case 'v': ++index; return '\x0b';
      case 'b': ++index; return '\b';
      case 'f': ++index; return '\f';

      // Backslash at the end of the line. We treat all line endings as equivalent,
      // and as representing the [LF] character (code 10). Lua 5.1 through 5.3
      // have been verified to behave the same way.
      case '\r':
      case '\n':
        consumeEOL();
        return '\n';

      case '0': case '1': case '2': case '3': case '4':
      case '5': case '6': case '7': case '8': case '9':
        // \ddd, where ddd is a sequence of up to three decimal digits.
        while (isDecDigit(input.charCodeAt(index)) && index - sequenceStart < 3) ++index;

        var frag = input.slice(sequenceStart, index);
        var ddd = parseInt(frag, 10);
        if (ddd > 255) {
          raise(null, errors.decimalEscapeTooLarge, '\\' + ddd);
        }
        return encodingMode.encodeByte(ddd, '\\' + frag);

      case 'z':
        if (features.skipWhitespaceEscape) {
          ++index;
          skipWhiteSpace();
          return '';
        }
        break;

      case 'x':
        if (features.hexEscapes) {
          // \xXX, where XX is a sequence of exactly two hexadecimal digits
          if (isHexDigit(input.charCodeAt(index + 1)) &&
              isHexDigit(input.charCodeAt(index + 2))) {
            index += 3;
            return encodingMode.encodeByte(parseInt(input.slice(sequenceStart + 1, index), 16), '\\' + input.slice(sequenceStart, index));
          }
          raise(null, errors.hexadecimalDigitExpected, '\\' + input.slice(sequenceStart, index + 2));
        }
        break;

      case 'u':
        if (features.unicodeEscapes)
          return readUnicodeEscapeSequence();
        break;

      case '\\': case '"': case "'":
        return input.charAt(index++);
    }

    if (features.strictEscapes)
      raise(null, errors.invalidEscape, '\\' + input.slice(sequenceStart, index + 1));
    return input.charAt(index++);
  }

  // Comments begin with -- after which it will be decided if they are
  // multiline comments or not.
  //
  // The multiline functionality works the exact same way as with string
  // literals so we reuse the functionality.

  function scanComment() {
    tokenStart = index;
    index += 2; // --

    var character = input.charAt(index)
      , content = ''
      , isLong = false
      , commentStart = index
      , lineStartComment = lineStart
      , lineComment = line;

    if ('[' === character) {
      content = readLongString(true);
      // This wasn't a multiline comment after all.
      if (false === content) content = character;
      else isLong = true;
    }
    // Scan until next line as long as it's not a multiline comment.
    if (!isLong) {
      while (index < length) {
        if (isLineTerminator(input.charCodeAt(index))) break;
        ++index;
      }
      if (options.comments) content = input.slice(commentStart, index);
    }

    if (options.comments) {
      var node = ast.comment(content, input.slice(tokenStart, index));

      // `Marker`s depend on tokens available in the parser and as comments are
      // intercepted in the lexer all location data is set manually.
      if (options.locations) {
        node.loc = {
            start: { line: lineComment, column: tokenStart - lineStartComment }
          , end: { line: line, column: index - lineStart }
        };
      }
      if (options.ranges) {
        node.range = [tokenStart, index];
      }
      if (options.onCreateNode) options.onCreateNode(node);
      comments.push(node);
    }
  }

  // Read a multiline string by calculating the depth of `=` characters and
  // then appending until an equal depth is found.

  function readLongString(isComment) {
    var level = 0
      , content = ''
      , terminator = false
      , character, stringStart, firstLine = line;

    ++index; // [

    // Calculate the depth of the comment.
    while ('=' === input.charAt(index + level)) ++level;
    // Exit, this is not a long string afterall.
    if ('[' !== input.charAt(index + level)) return false;

    index += level + 1;

    // If the first character is a newline, ignore it and begin on next line.
    if (isLineTerminator(input.charCodeAt(index))) consumeEOL();

    stringStart = index;
    while (index < length) {
      // To keep track of line numbers run the `consumeEOL()` which increments
      // its counter.
      while (isLineTerminator(input.charCodeAt(index))) consumeEOL();

      character = input.charAt(index++);

      // Once the delimiter is found, iterate through the depth count and see
      // if it matches.
      if (']' === character) {
        terminator = true;
        for (var i = 0; i < level; ++i) {
          if ('=' !== input.charAt(index + i)) terminator = false;
        }
        if (']' !== input.charAt(index + level)) terminator = false;
      }

      // We reached the end of the multiline string. Get out now.
      if (terminator) {
        content += input.slice(stringStart, index - 1);
        index += level + 1;
        return content;
      }
    }

    raise(null, isComment ?
                errors.unfinishedLongComment :
                errors.unfinishedLongString,
          firstLine, '<eof>');
  }

  // ## Lex functions and helpers.

  // Read the next token.
  //
  // This is actually done by setting the current token to the lookahead and
  // reading in the new lookahead token.

  function next() {
    previousToken = token;
    token = lookahead;
    lookahead = lex();
  }

  // Consume a token if its value matches. Once consumed or not, return the
  // success of the operation.

  function consume(value) {
    if (value === token.value) {
      next();
      return true;
    }
    return false;
  }

  // Expect the next token value to match. If not, throw an exception.

  function expect(value) {
    if (value === token.value) next();
    else raise(token, errors.expected, value, tokenValue(token));
  }

  // ### Validation functions

  function isWhiteSpace(charCode) {
    return 9 === charCode || 32 === charCode || 0xB === charCode || 0xC === charCode;
  }

  function isLineTerminator(charCode) {
    return 10 === charCode || 13 === charCode;
  }

  function isDecDigit(charCode) {
    return charCode >= 48 && charCode <= 57;
  }

  function isHexDigit(charCode) {
    return (charCode >= 48 && charCode <= 57) || (charCode >= 97 && charCode <= 102) || (charCode >= 65 && charCode <= 70);
  }

  // From [Lua 5.2](http://www.lua.org/manual/5.2/manual.html#8.1) onwards
  // identifiers cannot use 'locale-dependent' letters (i.e. dependent on the C locale).
  // On the other hand, LuaJIT allows arbitrary octets ≥ 128 in identifiers.

  function isIdentifierStart(charCode) {
    if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122) || 95 === charCode)
      return true;
    if (features.extendedIdentifiers && charCode >= 128)
      return true;
    return false;
  }

  function isIdentifierPart(charCode) {
    if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122) || 95 === charCode || (charCode >= 48 && charCode <= 57))
      return true;
    if (features.extendedIdentifiers && charCode >= 128)
      return true;
    return false;
  }

  // [3.1 Lexical Conventions](http://www.lua.org/manual/5.2/manual.html#3.1)
  //
  // `true`, `false` and `nil` will not be considered keywords, but literals.

  function isKeyword(id) {
    switch (id.length) {
      case 2:
        return 'do' === id || 'if' === id || 'in' === id || 'or' === id;
      case 3:
        return 'and' === id || 'end' === id || 'for' === id || 'not' === id;
      case 4:
        if ('else' === id || 'then' === id)
          return true;
        if (features.labels && !features.contextualGoto)
          return ('goto' === id);
        return false;
      case 5:
        return 'break' === id || 'local' === id || 'until' === id || 'while' === id;
      case 6:
        return 'elseif' === id || 'repeat' === id || 'return' === id;
      case 8:
        return 'function' === id;
    }
    return false;
  }

  function isUnary(token) {
    if (Punctuator === token.type) return '#-~'.indexOf(token.value) >= 0;
    if (Keyword === token.type) return 'not' === token.value;
    return false;
  }

  // Check if the token syntactically closes a block.

  function isBlockFollow(token) {
    if (EOF === token.type) return true;
    if (Keyword !== token.type) return false;
    switch (token.value) {
      case 'else': case 'elseif':
      case 'end': case 'until':
        return true;
      default:
        return false;
    }
  }

  // Scope
  // -----

  // Store each block scope as a an array of identifier names. Each scope is
  // stored in an FILO-array.
  var scopes
    // The current scope index
    , scopeDepth
    // A list of all global identifier nodes.
    , globals;

  // Create a new scope inheriting all declarations from the previous scope.
  function createScope() {
    var scope = scopes[scopeDepth++].slice();
    scopes.push(scope);
    if (options.onCreateScope) options.onCreateScope();
  }

  // Exit and remove the current scope.
  function destroyScope() {
    var scope = scopes.pop();
    --scopeDepth;
    if (options.onDestroyScope) options.onDestroyScope();
  }

  // Add identifier name to the current scope if it doesnt already exist.
  function scopeIdentifierName(name) {
    if (options.onLocalDeclaration) options.onLocalDeclaration(name);
    if (-1 !== indexOf(scopes[scopeDepth], name)) return;
    scopes[scopeDepth].push(name);
  }

  // Add identifier to the current scope
  function scopeIdentifier(node) {
    scopeIdentifierName(node.name);
    attachScope(node, true);
  }

  // Attach scope information to node. If the node is global, store it in the
  // globals array so we can return the information to the user.
  function attachScope(node, isLocal) {
    if (!isLocal && -1 === indexOfObject(globals, 'name', node.name))
      globals.push(node);

    node.isLocal = isLocal;
  }

  // Is the identifier name available in this scope.
  function scopeHasName(name) {
    return (-1 !== indexOf(scopes[scopeDepth], name));
  }

  // Location tracking
  // -----------------
  //
  // Locations are stored in FILO-array as a `Marker` object consisting of both
  // `loc` and `range` data. Once a `Marker` is popped off the list an end
  // location is added and the data is attached to a syntax node.

  var locations = []
    , trackLocations;

  function createLocationMarker() {
    return new Marker(token);
  }

  function Marker(token) {
    if (options.locations) {
      this.loc = {
          start: {
            line: token.line
          , column: token.range[0] - token.lineStart
        }
        , end: {
            line: 0
          , column: 0
        }
      };
    }
    if (options.ranges) this.range = [token.range[0], 0];
  }

  // Complete the location data stored in the `Marker` by adding the location
  // of the *previous token* as an end location.
  Marker.prototype.complete = function() {
    if (options.locations) {
      this.loc.end.line = previousToken.lastLine || previousToken.line;
      this.loc.end.column = previousToken.range[1] - (previousToken.lastLineStart || previousToken.lineStart);
    }
    if (options.ranges) {
      this.range[1] = previousToken.range[1];
    }
  };

  Marker.prototype.bless = function (node) {
    if (this.loc) {
      var loc = this.loc;
      node.loc = {
        start: {
          line: loc.start.line,
          column: loc.start.column
        },
        end: {
          line: loc.end.line,
          column: loc.end.column
        }
      };
    }
    if (this.range) {
      node.range = [
        this.range[0],
        this.range[1]
      ];
    }
  };

  // Create a new `Marker` and add it to the FILO-array.
  function markLocation() {
    if (trackLocations) locations.push(createLocationMarker());
  }

  // Push an arbitrary `Marker` object onto the FILO-array.
  function pushLocation(marker) {
    if (trackLocations) locations.push(marker);
  }

  // Control flow tracking
  // ---------------------
  // A context object that validates loop breaks and `goto`-based control flow.

  function FullFlowContext() {
    this.scopes = [];
    this.pendingGotos = [];
  }

  FullFlowContext.prototype.isInLoop = function () {
    var i = this.scopes.length;
    while (i --> 0) {
      if (this.scopes[i].isLoop)
        return true;
    }
    return false;
  };

  FullFlowContext.prototype.pushScope = function (isLoop) {
    var scope = {
      labels: {},
      locals: [],
      deferredGotos: [],
      isLoop: !!isLoop
    };
    this.scopes.push(scope);
  };

  FullFlowContext.prototype.popScope = function () {
    for (var i = 0; i < this.pendingGotos.length; ++i) {
      var theGoto = this.pendingGotos[i];
      if (theGoto.maxDepth >= this.scopes.length)
        if (--theGoto.maxDepth <= 0)
          raise(theGoto.token, errors.labelNotVisible, theGoto.target);
    }

    this.scopes.pop();
  };

  FullFlowContext.prototype.addGoto = function (target, token) {
    var localCounts = [];

    for (var i = 0; i < this.scopes.length; ++i) {
      var scope = this.scopes[i];
      localCounts.push(scope.locals.length);
      if (Object.prototype.hasOwnProperty.call(scope.labels, target))
        return;
    }

    this.pendingGotos.push({
      maxDepth: this.scopes.length,
      target: target,
      token: token,
      localCounts: localCounts
    });
  };

  FullFlowContext.prototype.addLabel = function (name, token) {
    var scope = this.currentScope();

    if (Object.prototype.hasOwnProperty.call(scope.labels, name)) {
      raise(token, errors.labelAlreadyDefined, name, scope.labels[name].line);
    } else {
      var newGotos = [];

      for (var i = 0; i < this.pendingGotos.length; ++i) {
        var theGoto = this.pendingGotos[i];

        if (theGoto.maxDepth >= this.scopes.length && theGoto.target === name) {
          if (theGoto.localCounts[this.scopes.length - 1] < scope.locals.length) {
            scope.deferredGotos.push(theGoto);
          }
          continue;
        }

        newGotos.push(theGoto);
      }

      this.pendingGotos = newGotos;
    }

    scope.labels[name] = {
      localCount: scope.locals.length,
      line: token.line
    };
  };

  FullFlowContext.prototype.addLocal = function (name, token) {
    this.currentScope().locals.push({
      name: name,
      token: token
    });
  };

  FullFlowContext.prototype.currentScope = function () {
    return this.scopes[this.scopes.length - 1];
  };

  FullFlowContext.prototype.raiseDeferredErrors = function () {
    var scope = this.currentScope();
    var bads = scope.deferredGotos;
    for (var i = 0; i < bads.length; ++i) {
      var theGoto = bads[i];
      raise(theGoto.token, errors.gotoJumpInLocalScope, theGoto.target, scope.locals[theGoto.localCounts[this.scopes.length - 1]].name);
    }
    // Would be dead code currently, but may be useful later
    // if (bads.length)
    //   scope.deferredGotos = [];
  };

  // Simplified context that only checks the validity of loop breaks.

  function LoopFlowContext() {
    this.level = 0;
    this.loopLevels = [];
  }

  LoopFlowContext.prototype.isInLoop = function () {
    return !!this.loopLevels.length;
  };

  LoopFlowContext.prototype.pushScope = function (isLoop) {
    ++this.level;
    if (isLoop)
      this.loopLevels.push(this.level);
  };

  LoopFlowContext.prototype.popScope = function () {
    var levels = this.loopLevels;
    var levlen = levels.length;
    if (levlen) {
      if (levels[levlen - 1] === this.level)
        levels.pop();
    }
    --this.level;
  };

  LoopFlowContext.prototype.addGoto =
  LoopFlowContext.prototype.addLabel =
  /* istanbul ignore next */
  function () { throw new Error('This should never happen'); };

  LoopFlowContext.prototype.addLocal =
  LoopFlowContext.prototype.raiseDeferredErrors =
  function () {};

  function makeFlowContext() {
    return features.labels ? new FullFlowContext() : new LoopFlowContext();
  }

  // Parse functions
  // ---------------

  // Chunk is the main program object. Syntactically it's the same as a block.
  //
  //     chunk ::= block

  function parseChunk() {
    next();
    markLocation();
    if (options.scope) createScope();
    var flowContext = makeFlowContext();
    flowContext.allowVararg = true;
    flowContext.pushScope();
    var body = parseBlock(flowContext);
    flowContext.popScope();
    if (options.scope) destroyScope();
    if (EOF !== token.type) unexpected(token);
    // If the body is empty no previousToken exists when finishNode runs.
    if (trackLocations && !body.length) previousToken = token;
    return finishNode(ast.chunk(body));
  }

  // A block contains a list of statements with an optional return statement
  // as its last statement.
  //
  //     block ::= {stat} [retstat]

  function parseBlock(flowContext) {
    var block = []
      , statement;

    while (!isBlockFollow(token)) {
      // Return has to be the last statement in a block.
      // Likewise 'break' in Lua older than 5.2
      if ('return' === token.value || (!features.relaxedBreak && 'break' === token.value)) {
        block.push(parseStatement(flowContext));
        break;
      }
      statement = parseStatement(flowContext);
      consume(';');
      // Statements are only added if they are returned, this allows us to
      // ignore some statements, such as EmptyStatement.
      if (statement) block.push(statement);
    }

    // Doesn't really need an ast node
    return block;
  }

  // There are two types of statements, simple and compound.
  //
  //     statement ::= break | goto | do | while | repeat | return
  //          | if | for | function | local | label | assignment
  //          | functioncall | ';'

  function parseStatement(flowContext) {
    markLocation();

    if (Punctuator === token.type) {
      if (consume('::')) return parseLabelStatement(flowContext);
    }

    // When a `;` is encounted, simply eat it without storing it.
    if (features.emptyStatement) {
      if (consume(';')) {
        if (trackLocations) locations.pop();
        return;
      }
    }

    flowContext.raiseDeferredErrors();

    if (Keyword === token.type) {
      switch (token.value) {
        case 'local':    next(); return parseLocalStatement(flowContext);
        case 'if':       next(); return parseIfStatement(flowContext);
        case 'return':   next(); return parseReturnStatement(flowContext);
        case 'function': next();
          var name = parseFunctionName();
          return parseFunctionDeclaration(name);
        case 'while':    next(); return parseWhileStatement(flowContext);
        case 'for':      next(); return parseForStatement(flowContext);
        case 'repeat':   next(); return parseRepeatStatement(flowContext);
        case 'break':    next();
          if (!flowContext.isInLoop())
            raise(token, errors.noLoopToBreak, token.value);
          return parseBreakStatement();
        case 'do':       next(); return parseDoStatement(flowContext);
        case 'goto':     next(); return parseGotoStatement(flowContext);
      }
    }

    if (features.contextualGoto &&
        token.type === Identifier && token.value === 'goto' &&
        lookahead.type === Identifier && lookahead.value !== 'goto') {
      next(); return parseGotoStatement(flowContext);
    }

    // Assignments memorizes the location and pushes it manually for wrapper nodes.
    if (trackLocations) locations.pop();

    return parseAssignmentOrCallStatement(flowContext);
  }

  // ## Statements

  //     label ::= '::' Name '::'

  function parseLabelStatement(flowContext) {
    var nameToken = token
      , label = parseIdentifier();

    if (options.scope) {
      scopeIdentifierName('::' + nameToken.value + '::');
      attachScope(label, true);
    }

    expect('::');

    flowContext.addLabel(nameToken.value, nameToken);
    return finishNode(ast.labelStatement(label));
  }

  //     break ::= 'break'

  function parseBreakStatement() {
    return finishNode(ast.breakStatement());
  }

  //     goto ::= 'goto' Name

  function parseGotoStatement(flowContext) {
    var name = token.value
      , gotoToken = previousToken
      , label = parseIdentifier();

    flowContext.addGoto(name, gotoToken);
    return finishNode(ast.gotoStatement(label));
  }

  //     do ::= 'do' block 'end'

  function parseDoStatement(flowContext) {
    if (options.scope) createScope();
    flowContext.pushScope();
    var body = parseBlock(flowContext);
    flowContext.popScope();
    if (options.scope) destroyScope();
    expect('end');
    return finishNode(ast.doStatement(body));
  }

  //     while ::= 'while' exp 'do' block 'end'

  function parseWhileStatement(flowContext) {
    var condition = parseExpectedExpression(flowContext);
    expect('do');
    if (options.scope) createScope();
    flowContext.pushScope(true);
    var body = parseBlock(flowContext);
    flowContext.popScope();
    if (options.scope) destroyScope();
    expect('end');
    return finishNode(ast.whileStatement(condition, body));
  }

  //     repeat ::= 'repeat' block 'until' exp

  function parseRepeatStatement(flowContext) {
    if (options.scope) createScope();
    flowContext.pushScope(true);
    var body = parseBlock(flowContext);
    expect('until');
    flowContext.raiseDeferredErrors();
    var condition = parseExpectedExpression(flowContext);
    flowContext.popScope();
    if (options.scope) destroyScope();
    return finishNode(ast.repeatStatement(condition, body));
  }

  //     retstat ::= 'return' [exp {',' exp}] [';']

  function parseReturnStatement(flowContext) {
    var expressions = [];

    if ('end' !== token.value) {
      var expression = parseExpression(flowContext);
      if (null != expression) expressions.push(expression);
      while (consume(',')) {
        expression = parseExpectedExpression(flowContext);
        expressions.push(expression);
      }
      consume(';'); // grammar tells us ; is optional here.
    }
    return finishNode(ast.returnStatement(expressions));
  }

  //     if ::= 'if' exp 'then' block {elif} ['else' block] 'end'
  //     elif ::= 'elseif' exp 'then' block

  function parseIfStatement(flowContext) {
    var clauses = []
      , condition
      , body
      , marker;

    // IfClauses begin at the same location as the parent IfStatement.
    // It ends at the start of `end`, `else`, or `elseif`.
    if (trackLocations) {
      marker = locations[locations.length - 1];
      locations.push(marker);
    }
    condition = parseExpectedExpression(flowContext);
    expect('then');
    if (options.scope) createScope();
    flowContext.pushScope();
    body = parseBlock(flowContext);
    flowContext.popScope();
    if (options.scope) destroyScope();
    clauses.push(finishNode(ast.ifClause(condition, body)));

    if (trackLocations) marker = createLocationMarker();
    while (consume('elseif')) {
      pushLocation(marker);
      condition = parseExpectedExpression(flowContext);
      expect('then');
      if (options.scope) createScope();
      flowContext.pushScope();
      body = parseBlock(flowContext);
      flowContext.popScope();
      if (options.scope) destroyScope();
      clauses.push(finishNode(ast.elseifClause(condition, body)));
      if (trackLocations) marker = createLocationMarker();
    }

    if (consume('else')) {
      // Include the `else` in the location of ElseClause.
      if (trackLocations) {
        marker = new Marker(previousToken);
        locations.push(marker);
      }
      if (options.scope) createScope();
      flowContext.pushScope();
      body = parseBlock(flowContext);
      flowContext.popScope();
      if (options.scope) destroyScope();
      clauses.push(finishNode(ast.elseClause(body)));
    }

    expect('end');
    return finishNode(ast.ifStatement(clauses));
  }

  // There are two types of for statements, generic and numeric.
  //
  //     for ::= Name '=' exp ',' exp [',' exp] 'do' block 'end'
  //     for ::= namelist 'in' explist 'do' block 'end'
  //     namelist ::= Name {',' Name}
  //     explist ::= exp {',' exp}

  function parseForStatement(flowContext) {
    var variable = parseIdentifier()
      , body;

    // The start-identifier is local.

    if (options.scope) {
      createScope();
      scopeIdentifier(variable);
    }

    // If the first expression is followed by a `=` punctuator, this is a
    // Numeric For Statement.
    if (consume('=')) {
      // Start expression
      var start = parseExpectedExpression(flowContext);
      expect(',');
      // End expression
      var end = parseExpectedExpression(flowContext);
      // Optional step expression
      var step = consume(',') ? parseExpectedExpression(flowContext) : null;

      expect('do');
      flowContext.pushScope(true);
      body = parseBlock(flowContext);
      flowContext.popScope();
      expect('end');
      if (options.scope) destroyScope();

      return finishNode(ast.forNumericStatement(variable, start, end, step, body));
    }
    // If not, it's a Generic For Statement
    else {
      // The namelist can contain one or more identifiers.
      var variables = [variable];
      while (consume(',')) {
        variable = parseIdentifier();
        // Each variable in the namelist is locally scoped.
        if (options.scope) scopeIdentifier(variable);
        variables.push(variable);
      }
      expect('in');
      var iterators = [];

      // One or more expressions in the explist.
      do {
        var expression = parseExpectedExpression(flowContext);
        iterators.push(expression);
      } while (consume(','));

      expect('do');
      flowContext.pushScope(true);
      body = parseBlock(flowContext);
      flowContext.popScope();
      expect('end');
      if (options.scope) destroyScope();

      return finishNode(ast.forGenericStatement(variables, iterators, body));
    }
  }

  // Local statements can either be variable assignments or function
  // definitions. If a function definition is found, it will be delegated to
  // `parseFunctionDeclaration()` with the isLocal flag.
  //
  // This AST structure might change into a local assignment with a function
  // child.
  //
  //     local ::= 'local' 'function' Name funcdecl
  //        | 'local' Name {',' Name} ['=' exp {',' exp}]

  function parseLocalStatement(flowContext) {
    var name
      , declToken = previousToken;

    if (Identifier === token.type) {
      var variables = []
        , init = [];

      do {
        name = parseIdentifier();

        variables.push(name);
        flowContext.addLocal(name.name, declToken);
      } while (consume(','));

      if (consume('=')) {
        do {
          var expression = parseExpectedExpression(flowContext);
          init.push(expression);
        } while (consume(','));
      }

      // Declarations doesn't exist before the statement has been evaluated.
      // Therefore assignments can't use their declarator. And the identifiers
      // shouldn't be added to the scope until the statement is complete.
      if (options.scope) {
        for (var i = 0, l = variables.length; i < l; ++i) {
          scopeIdentifier(variables[i]);
        }
      }

      return finishNode(ast.localStatement(variables, init));
    }
    if (consume('function')) {
      name = parseIdentifier();
      flowContext.addLocal(name.name, declToken);

      if (options.scope) {
        scopeIdentifier(name);
        createScope();
      }

      // MemberExpressions are not allowed in local function statements.
      return parseFunctionDeclaration(name, true);
    } else {
      raiseUnexpectedToken('<name>', token);
    }
  }

  //     assignment ::= varlist '=' explist
  //     var ::= Name | prefixexp '[' exp ']' | prefixexp '.' Name
  //     varlist ::= var {',' var}
  //     explist ::= exp {',' exp}
  //
  //     call ::= callexp
  //     callexp ::= prefixexp args | prefixexp ':' Name args

  function parseAssignmentOrCallStatement(flowContext) {
    // Keep a reference to the previous token for better error messages in case
    // of invalid statement
    var previous = token
      , marker, startMarker;
    var lvalue, base, name;

    var targets = [];

    if (trackLocations) startMarker = createLocationMarker();

    do {
      if (trackLocations) marker = createLocationMarker();

      if (Identifier === token.type) {
        name = token.value;
        base = parseIdentifier();
        // Set the parent scope.
        if (options.scope) attachScope(base, scopeHasName(name));
        lvalue = true;
      } else if ('(' === token.value) {
        next();
        base = parseExpectedExpression(flowContext);
        expect(')');
        lvalue = false;
      } else {
        return unexpected(token);
      }

      both: for (;;) {
        var newBase;

        switch (StringLiteral === token.type ? '"' : token.value) {
        case '.':
        case '[':
          lvalue = true;
          break;
        case ':':
        case '(':
        case '{':
        case '"':
          lvalue = null;
          break;
        default:
          break both;
        }

        base = parsePrefixExpressionPart(base, marker, flowContext);
      }

      targets.push(base);

      if (',' !== token.value)
        break;

      if (!lvalue) {
        return unexpected(token);
      }

      next();
    } while (true);

    if (targets.length === 1 && lvalue === null) {
      pushLocation(marker);
      return finishNode(ast.callStatement(targets[0]));
    } else if (!lvalue) {
      return unexpected(token);
    }

    expect('=');

    var values = [];

    do {
      values.push(parseExpectedExpression(flowContext));
    } while (consume(','));

    pushLocation(startMarker);
    return finishNode(ast.assignmentStatement(targets, values));
  }

  // ### Non-statements

  //     Identifier ::= Name

  function parseIdentifier() {
    markLocation();
    var identifier = token.value;
    if (Identifier !== token.type) raiseUnexpectedToken('<name>', token);
    next();
    return finishNode(ast.identifier(identifier));
  }

  // Parse the functions parameters and body block. The name should already
  // have been parsed and passed to this declaration function. By separating
  // this we allow for anonymous functions in expressions.
  //
  // For local functions there's a boolean parameter which needs to be set
  // when parsing the declaration.
  //
  //     funcdecl ::= '(' [parlist] ')' block 'end'
  //     parlist ::= Name {',' Name} | [',' '...'] | '...'

  function parseFunctionDeclaration(name, isLocal) {
    var flowContext = makeFlowContext();
    flowContext.pushScope();

    var parameters = [];
    expect('(');

    // The declaration has arguments
    if (!consume(')')) {
      // Arguments are a comma separated list of identifiers, optionally ending
      // with a vararg.
      while (true) {
        if (Identifier === token.type) {
          var parameter = parseIdentifier();
          // Function parameters are local.
          if (options.scope) scopeIdentifier(parameter);

          parameters.push(parameter);

          if (consume(',')) continue;
        }
        // No arguments are allowed after a vararg.
        else if (VarargLiteral === token.type) {
          flowContext.allowVararg = true;
          parameters.push(parsePrimaryExpression(flowContext));
        } else {
          raiseUnexpectedToken('<name> or \'...\'', token);
        }
        expect(')');
        break;
      }
    }

    var body = parseBlock(flowContext);
    flowContext.popScope();
    expect('end');
    if (options.scope) destroyScope();

    isLocal = isLocal || false;
    return finishNode(ast.functionStatement(name, parameters, isLocal, body));
  }

  // Parse the function name as identifiers and member expressions.
  //
  //     Name {'.' Name} [':' Name]

  function parseFunctionName() {
    var base, name, marker;

    if (trackLocations) marker = createLocationMarker();
    base = parseIdentifier();

    if (options.scope) {
      attachScope(base, scopeHasName(base.name));
      createScope();
    }

    while (consume('.')) {
      pushLocation(marker);
      name = parseIdentifier();
      base = finishNode(ast.memberExpression(base, '.', name));
    }

    if (consume(':')) {
      pushLocation(marker);
      name = parseIdentifier();
      base = finishNode(ast.memberExpression(base, ':', name));
      if (options.scope) scopeIdentifierName('self');
    }

    return base;
  }

  //     tableconstructor ::= '{' [fieldlist] '}'
  //     fieldlist ::= field {fieldsep field} fieldsep
  //     field ::= '[' exp ']' '=' exp | Name = 'exp' | exp
  //
  //     fieldsep ::= ',' | ';'

  function parseTableConstructor(flowContext) {
    var fields = []
      , key, value;

    while (true) {
      markLocation();
      if (Punctuator === token.type && consume('[')) {
        key = parseExpectedExpression(flowContext);
        expect(']');
        expect('=');
        value = parseExpectedExpression(flowContext);
        fields.push(finishNode(ast.tableKey(key, value)));
      } else if (Identifier === token.type) {
        if ('=' === lookahead.value) {
          key = parseIdentifier();
          next();
          value = parseExpectedExpression(flowContext);
          fields.push(finishNode(ast.tableKeyString(key, value)));
        } else {
          value = parseExpectedExpression(flowContext);
          fields.push(finishNode(ast.tableValue(value)));
        }
      } else {
        if (null == (value = parseExpression(flowContext))) {
          locations.pop();
          break;
        }
        fields.push(finishNode(ast.tableValue(value)));
      }
      if (',;'.indexOf(token.value) >= 0) {
        next();
        continue;
      }
      break;
    }
    expect('}');
    return finishNode(ast.tableConstructorExpression(fields));
  }

  // Expression parser
  // -----------------
  //
  // Expressions are evaluated and always return a value. If nothing is
  // matched null will be returned.
  //
  //     exp ::= (unop exp | primary | prefixexp ) { binop exp }
  //
  //     primary ::= nil | false | true | Number | String | '...'
  //          | functiondef | tableconstructor
  //
  //     prefixexp ::= (Name | '(' exp ')' ) { '[' exp ']'
  //          | '.' Name | ':' Name args | args }
  //

  function parseExpression(flowContext) {
    var expression = parseSubExpression(0, flowContext);
    return expression;
  }

  // Parse an expression expecting it to be valid.

  function parseExpectedExpression(flowContext) {
    var expression = parseExpression(flowContext);
    if (null == expression) raiseUnexpectedToken('<expression>', token);
    else return expression;
  }


  // Return the precedence priority of the operator.
  //
  // As unary `-` can't be distinguished from binary `-`, unary precedence
  // isn't described in this table but in `parseSubExpression()` itself.
  //
  // As this function gets hit on every expression it's been optimized due to
  // the expensive CompareICStub which took ~8% of the parse time.

  function binaryPrecedence(operator) {
    var charCode = operator.charCodeAt(0)
      , length = operator.length;

    if (1 === length) {
      switch (charCode) {
        case 94: return 12; // ^
        case 42: case 47: case 37: return 10; // * / %
        case 43: case 45: return 9; // + -
        case 38: return 6; // &
        case 126: return 5; // ~
        case 124: return 4; // |
        case 60: case 62: return 3; // < >
      }
    } else if (2 === length) {
      switch (charCode) {
        case 47: return 10; // //
        case 46: return 8; // ..
        case 60: case 62:
            if('<<' === operator || '>>' === operator) return 7; // << >>
            return 3; // <= >=
        case 61: case 126: return 3; // == ~=
        case 111: return 1; // or
      }
    } else if (97 === charCode && 'and' === operator) return 2;
    return 0;
  }

  // Implement an operator-precedence parser to handle binary operator
  // precedence.
  //
  // We use this algorithm because it's compact, it's fast and Lua core uses
  // the same so we can be sure our expressions are parsed in the same manner
  // without excessive amounts of tests.
  //
  //     exp ::= (unop exp | primary | prefixexp ) { binop exp }

  function parseSubExpression(minPrecedence, flowContext) {
    var operator = token.value
    // The left-hand side in binary operations.
      , expression, marker;

    if (trackLocations) marker = createLocationMarker();

    // UnaryExpression
    if (isUnary(token)) {
      markLocation();
      next();
      var argument = parseSubExpression(10, flowContext);
      if (argument == null) raiseUnexpectedToken('<expression>', token);
      expression = finishNode(ast.unaryExpression(operator, argument));
    }
    if (null == expression) {
      // PrimaryExpression
      expression = parsePrimaryExpression(flowContext);

      // PrefixExpression
      if (null == expression) {
        expression = parsePrefixExpression(flowContext);
      }
    }
    // This is not a valid left hand expression.
    if (null == expression) return null;

    var precedence;
    while (true) {
      operator = token.value;

      precedence = (Punctuator === token.type || Keyword === token.type) ?
        binaryPrecedence(operator) : 0;

      if (precedence === 0 || precedence <= minPrecedence) break;
      // Right-hand precedence operators
      if ('^' === operator || '..' === operator) --precedence;
      next();
      var right = parseSubExpression(precedence, flowContext);
      if (null == right) raiseUnexpectedToken('<expression>', token);
      // Push in the marker created before the loop to wrap its entirety.
      if (trackLocations) locations.push(marker);
      expression = finishNode(ast.binaryExpression(operator, expression, right));

    }
    return expression;
  }

  //     prefixexp ::= prefix {suffix}
  //     prefix ::= Name | '(' exp ')'
  //     suffix ::= '[' exp ']' | '.' Name | ':' Name args | args
  //
  //     args ::= '(' [explist] ')' | tableconstructor | String

  function parsePrefixExpressionPart(base, marker, flowContext) {
    var expression, identifier;

    if (Punctuator === token.type) {
      switch (token.value) {
        case '[':
          pushLocation(marker);
          next();
          expression = parseExpectedExpression(flowContext);
          expect(']');
          return finishNode(ast.indexExpression(base, expression));
        case '.':
          pushLocation(marker);
          next();
          identifier = parseIdentifier();
          return finishNode(ast.memberExpression(base, '.', identifier));
        case ':':
          pushLocation(marker);
          next();
          identifier = parseIdentifier();
          base = finishNode(ast.memberExpression(base, ':', identifier));
          // Once a : is found, this has to be a CallExpression, otherwise
          // throw an error.
          pushLocation(marker);
          return parseCallExpression(base, flowContext);
        case '(': case '{': // args
          pushLocation(marker);
          return parseCallExpression(base, flowContext);
      }
    } else if (StringLiteral === token.type) {
      pushLocation(marker);
      return parseCallExpression(base, flowContext);
    }

    return null;
  }

  function parsePrefixExpression(flowContext) {
    var base, name, marker;

    if (trackLocations) marker = createLocationMarker();

    // The prefix
    if (Identifier === token.type) {
      name = token.value;
      base = parseIdentifier();
      // Set the parent scope.
      if (options.scope) attachScope(base, scopeHasName(name));
    } else if (consume('(')) {
      base = parseExpectedExpression(flowContext);
      expect(')');
    } else {
      return null;
    }

    // The suffix
    for (;;) {
      var newBase = parsePrefixExpressionPart(base, marker, flowContext);
      if (newBase === null)
        break;
      base = newBase;
    }

    return base;
  }

  //     args ::= '(' [explist] ')' | tableconstructor | String

  function parseCallExpression(base, flowContext) {
    if (Punctuator === token.type) {
      switch (token.value) {
        case '(':
          if (!features.emptyStatement) {
            if (token.line !== previousToken.line)
              raise(null, errors.ambiguousSyntax, token.value);
          }
          next();

          // List of expressions
          var expressions = [];
          var expression = parseExpression(flowContext);
          if (null != expression) expressions.push(expression);
          while (consume(',')) {
            expression = parseExpectedExpression(flowContext);
            expressions.push(expression);
          }

          expect(')');
          return finishNode(ast.callExpression(base, expressions));

        case '{':
          markLocation();
          next();
          var table = parseTableConstructor(flowContext);
          return finishNode(ast.tableCallExpression(base, table));
      }
    } else if (StringLiteral === token.type) {
      return finishNode(ast.stringCallExpression(base, parsePrimaryExpression(flowContext)));
    }

    raiseUnexpectedToken('function arguments', token);
  }

  //     primary ::= String | Numeric | nil | true | false
  //          | functiondef | tableconstructor | '...'

  function parsePrimaryExpression(flowContext) {
    var literals = StringLiteral | NumericLiteral | BooleanLiteral | NilLiteral | VarargLiteral
      , value = token.value
      , type = token.type
      , marker;

    if (trackLocations) marker = createLocationMarker();

    if (type === VarargLiteral && !flowContext.allowVararg) {
      raise(token, errors.cannotUseVararg, token.value);
    }

    if (type & literals) {
      pushLocation(marker);
      var raw = input.slice(token.range[0], token.range[1]);
      next();
      return finishNode(ast.literal(type, value, raw));
    } else if (Keyword === type && 'function' === value) {
      pushLocation(marker);
      next();
      if (options.scope) createScope();
      return parseFunctionDeclaration(null);
    } else if (consume('{')) {
      pushLocation(marker);
      return parseTableConstructor(flowContext);
    }
  }

  // Parser
  // ------

  // Export the main parser.
  //
  //   - `wait` Hold parsing until end() is called. Defaults to false
  //   - `comments` Store comments. Defaults to true.
  //   - `scope` Track identifier scope. Defaults to false.
  //   - `locations` Store location information. Defaults to false.
  //   - `ranges` Store the start and end character locations. Defaults to
  //     false.
  //   - `onCreateNode` Callback which will be invoked when a syntax node is
  //     created.
  //   - `onCreateScope` Callback which will be invoked when a new scope is
  //     created.
  //   - `onDestroyScope` Callback which will be invoked when the current scope
  //     is destroyed.
  //
  // Example:
  //
  //     var parser = require('luaparser');
  //     parser.parse('i = 0');

  exports.parse = parse;

  var versionFeatures = {
    '5.1': {
    },
    '5.2': {
      labels: true,
      emptyStatement: true,
      hexEscapes: true,
      skipWhitespaceEscape: true,
      strictEscapes: true,
      relaxedBreak: true
    },
    '5.3': {
      labels: true,
      emptyStatement: true,
      hexEscapes: true,
      skipWhitespaceEscape: true,
      strictEscapes: true,
      unicodeEscapes: true,
      bitwiseOperators: true,
      integerDivision: true,
      relaxedBreak: true
    },
    'LuaJIT': {
      // XXX: LuaJIT language features may depend on compilation options; may need to
      // rethink how to handle this. Specifically, there is a LUAJIT_ENABLE_LUA52COMPAT
      // that removes contextual goto. Maybe add 'LuaJIT-5.2compat' as well?
      labels: true,
      contextualGoto: true,
      hexEscapes: true,
      skipWhitespaceEscape: true,
      strictEscapes: true,
      unicodeEscapes: true,
      imaginaryNumbers: true,
      integerSuffixes: true
    }
  };

  function parse(_input, _options) {
    if ('undefined' === typeof _options && 'object' === typeof _input) {
      _options = _input;
      _input = undefined;
    }
    if (!_options) _options = {};

    input = _input || '';
    options = assign({}, defaultOptions, _options);

    // Rewind the lexer
    index = 0;
    line = 1;
    lineStart = 0;
    length = input.length;
    // When tracking identifier scope, initialize with an empty scope.
    scopes = [[]];
    scopeDepth = 0;
    globals = [];
    locations = [];

    if (!Object.prototype.hasOwnProperty.call(versionFeatures, options.luaVersion)) {
      throw new Error(sprintf("Lua version '%1' not supported", options.luaVersion));
    }

    features = assign({}, versionFeatures[options.luaVersion]);
    if (options.extendedIdentifiers !== void 0)
      features.extendedIdentifiers = !!options.extendedIdentifiers;

    if (!Object.prototype.hasOwnProperty.call(encodingModes, options.encodingMode)) {
      throw new Error(sprintf("Encoding mode '%1' not supported", options.encodingMode));
    }

    encodingMode = encodingModes[options.encodingMode];

    if (options.comments) comments = [];
    if (!options.wait) return end();
    return exports;
  }

  // Write to the source code buffer without beginning the parse.
  exports.write = write;

  function write(_input) {
    input += String(_input);
    length = input.length;
    return exports;
  }

  // Send an EOF and begin parsing.
  exports.end = end;

  function end(_input) {
    if ('undefined' !== typeof _input) write(_input);

    // Ignore shebangs.
    if (input && input.substr(0, 2) === '#!') input = input.replace(/^.*/, function (line) {
      return line.replace(/./g, ' ');
    });

    length = input.length;
    trackLocations = options.locations || options.ranges;
    // Initialize with a lookahead token.
    lookahead = lex();

    var chunk = parseChunk();
    if (options.comments) chunk.comments = comments;
    if (options.scope) chunk.globals = globals;

    /* istanbul ignore if */
    if (locations.length > 0)
      throw new Error('Location tracking failed. This is most likely a bug in luaparse');

    return chunk;
  }

}));
/* vim: set sw=2 ts=2 et tw=79 : */

return module.exports;})();
const overrides = {
  alternatehunt: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'alternatehunt.png',
    i18n: {
      zh: '追猎惊喜',
      en: 'Hunt Surprises',
    },
  },
  angrybees: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'angrybees.png',
    i18n: {
      zh: '杀人蜂巢',
      en: 'Killer Bee Hives',
    },
  },
  antliontribute: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'antliontribute.png',
    i18n: {
      zh: '蚁狮',
      en: 'Antlion Tribute',
    },
  },
  autumn: {
    configs: ["noseason", "veryshortseason", "shortseason", "default", "longseason", "verylongseason", "random"],
    modelValue: 'default',
    image: 'autumn.png',
    i18n: {
      zh: '秋天',
      en: 'Autumn',
    },
  },
  bananabush_portalrate: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'bananabush_portalrate.png',
    i18n: {
      zh: '香蕉丛',
      en: 'Banana Bushes',
    },
  },
  basicresource_regrowth: {
    configs: ["none", "always"],
    customConfigsValue: {
      none: {
        zh: '禁用',
        en: 'Disable',
      },
      always: {
        zh: '启用',
        en: 'Enable',
      },
    },
    modelValue: 'none',
    image: 'basicresource_regrowth.png',
    i18n: {
      zh: '基础资源',
      en: 'Basic Resource',
    },
  },
  bats_setting: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'bats_setting.png',
    i18n: {
      zh: '蝙蝠',
      en: 'bats_setting',
    },
  },
  bearger: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'bearger.png',
    i18n: {
      zh: '熊獾',
      en: 'bearger',
    },
  },
  beefalo: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'beefalo.png',
    i18n: {
      zh: '皮弗娄牛',
      en: 'beefalo',
    },
  },
  beefaloheat: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'beefaloheat.png',
    i18n: {
      zh: '皮弗娄牛交配频率',
      en: 'Beefalo Mating Frequency',
    },
  },
  beequeen: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'beequeen.png',
    i18n: {
      zh: '蜂王',
      en: 'beequeen',
    },
  },
  bees: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'bees.png',
    i18n: {
      zh: '蜜蜂蜂窝',
      en: 'bees',
    },
  },
  bees_setting: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'bees_setting.png',
    i18n: {
      zh: '蜜蜂',
      en: 'bees_setting',
    },
  },
  berrybush: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'berrybush.png',
    i18n: {
      zh: '浆果丛',
      en: 'berrybush',
    },
  },
  birds: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'birds.png',
    i18n: {
      zh: '鸟',
      en: 'birds',
    },
  },
  boons: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'boons.png',
    i18n: {
      zh: '失败的冒险家',
      en: 'boons',
    },
  },
  branching: {
    configs: ["never", "least", "default", "most", "random"],
    modelValue: 'default',
    image: 'branching.png',
    i18n: {
      zh: '分支',
      en: 'branching',
    },
  },
  brightmarecreatures: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'brightmarecreatures.png',
    i18n: {
      zh: '启蒙怪兽',
      en: 'brightmarecreatures',
    },
  },
  bunnymen_setting: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'bunnymen_setting.png',
    i18n: {
      zh: '兔人',
      en: 'bunnymen_setting',
    },
  },
  butterfly: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'butterfly.png',
    i18n: {
      zh: '蝴蝶',
      en: 'butterfly',
    },
  },
  buzzard: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'buzzard.png',
    i18n: {
      zh: '秃鹫',
      en: 'buzzard',
    },
  },
  cactus: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'cactus.png',
    i18n: {
      zh: '仙人掌',
      en: 'cactus',
    },
  },
  cactus_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'cactus.png',
    i18n: {
      zh: '仙人掌',
      en: 'cactus_regrowth',
    },
  },
  carrot: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'carrot.png',
    i18n: {
      zh: '胡萝卜',
      en: 'carrot',
    },
  },
  carrots_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'carrot.png',
    i18n: {
      zh: '胡萝卜',
      en: 'carrots_regrowth',
    },
  },
  catcoon: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'catcoon.png',
    i18n: {
      zh: '空心树桩',
      en: 'catcoon',
    },
  },
  catcoons: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'catcoons.png',
    i18n: {
      zh: '浣猫',
      en: 'catcoons',
    },
  },
  chess: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'chess.png',
    i18n: {
      zh: '发条装置',
      en: 'chess',
    },
  },
  cookiecutters: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'cookiecutters.png',
    i18n: {
      zh: '饼干切割机',
      en: 'cookiecutters',
    },
  },
  crabking: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'crabking.png',
    i18n: {
      zh: '帝王蟹',
      en: 'crabking',
    },
  },
  crow_carnival: {
    configs: ["default", "enabled"],
    modelValue: 'default',
    image: 'crow_carnival.png',
    i18n: {
      zh: '盛夏鸦年华',
      en: 'Midsummer Cawnival',
    },
  },
  darkness: {
    configs: ["nonlethal", "default"],
    customConfigsValue: {
      nonlethal: {
        zh: '非致命',
        en: 'enabled',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
    },
    modelValue: 'default',
    image: 'darkness.png',
    i18n: {
      zh: '黑暗伤害',
      en: 'darkness',
    },
  },
  day: {
    configs: ["default", "longday", "longdusk", "longnight", "noday", "nodusk", "nonight", "onlyday", "onlydusk", "onlynight"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      longday: {
        zh: '长 白天',
        en: 'longday',
      },
      longdusk: {
        zh: '长 黄昏',
        en: 'longdusk',
      },
      longnight: {
        zh: '长 夜晚',
        en: 'longnight',
      },
      noday: {
        zh: '无 白天',
        en: 'noday',
      },
      nodusk: {
        zh: '无 黄昏',
        en: 'nodusk',
      },
      nonight: {
        zh: '无 夜晚',
        en: 'nonight',
      },
      onlyday: {
        zh: '仅 白天',
        en: 'onlyday',
      },
      onlydusk: {
        zh: '仅 黄昏',
        en: 'onlydusk',
      },
      onlynight: {
        zh: '仅 夜晚',
        en: 'onlynight',
      },
    },
    modelValue: 'default',
    image: 'day.png',
    i18n: {
      zh: '昼夜选项',
      en: 'Day Type',
    },
  },
  daywalker2: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'daywalker2.png',
    i18n: {
      zh: '拾荒疯猪',
      en: 'daywalker2',
    },
  },
  deciduousmonster: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'deciduousmonster.png',
    i18n: {
      zh: '毒桦栗树',
      en: 'deciduousmonster',
    },
  },
  deciduoustree_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'deciduoustree_regrowth.png',
    i18n: {
      zh: '桦栗树',
      en: 'deciduoustree_regrowth',
    },
  },
  deerclops: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'deerclops.png',
    i18n: {
      zh: '独眼巨鹿',
      en: 'deerclops',
    },
  },
  dragonfly: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'dragonfly.png',
    i18n: {
      zh: '龙蝇',
      en: 'dragonfly',
    },
  },
  dropeverythingondespawn: {
    configs: ["default", "always"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      always: {
        zh: '所有',
        en: 'Everything',
      },
    },
    modelValue: 'default',
    image: 'dropeverythingondespawn.png',
    i18n: {
      zh: '离开游戏后物品掉落',
      en: 'Drop Items On Disconnect',
    },
  },
  evergreen_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'evergreen_regrowth.png',
    i18n: {
      zh: '常青树',
      en: 'evergreen_regrowth',
    },
  },
  extrastartingitems: {
    configs: ["0", "5", "default", "15", "20", "none"],
    customConfigsValue: {
      "0": {
        zh: '总是',
        en: 'Always',
      },
      "5": {
        zh: '第5天后',
        en: 'Day After 5',
      },
      "15": {
        zh: '第15天后',
        en: 'Day After 15',
      },
      "20": {
        zh: '第20天后',
        en: 'Day After 20',
      },
      default: {
        zh: '第10天后',
        en: 'Day After 10',
      },
      none: {
        zh: '从不',
        en: 'Never',
      },
    },
    modelValue: 'default',
    image: 'extrastartingitems.png',
    i18n: {
      zh: '额外起始资源',
      en: 'Extra Starting Resources',
    },
  },
  eyeofterror: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'eyeofterror.png',
    i18n: {
      zh: '恐怖之眼',
      en: 'eyeofterror',
    },
  },
  fishschools: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'fishschools.png',
    i18n: {
      zh: '鱼群',
      en: 'fishschools',
    },
  },
  flint: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'flint.png',
    i18n: {
      zh: '燧石',
      en: 'flint',
    },
  },
  flowers: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'flowers.png',
    i18n: {
      zh: '花，邪恶花',
      en: 'flowers',
    },
  },
  flowers_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'flowers.png',
    i18n: {
      zh: '花',
      en: 'flowers_regrowth',
    },
  },
  frograin: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'frograin.png',
    i18n: {
      zh: '青蛙雨',
      en: 'frograin',
    },
  },
  frogs: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'frogs.png',
    i18n: {
      zh: '青蛙',
      en: 'frogs',
    },
  },
  fruitfly: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'fruitfly.png',
    i18n: {
      zh: '果蝇王',
      en: 'fruitfly',
    },
  },
  ghostenabled: {
    configs: ["none", "always"],
    customConfigsValue: {
      none: {
        zh: '更改冒险家',
        en: 'none',
      },
      always: {
        zh: '变鬼魂',
        en: 'always',
      },
    },
    modelValue: 'always',
    image: 'ghostenabled.png',
    i18n: {
      zh: '冒险家死亡',
      en: 'Survivor Death',
    },
  },
  ghostsanitydrain: {
    configs: ["none", "always"],
    customConfigsValue: {
      none: {
        zh: '禁用',
        en: 'none',
      },
      always: {
        zh: '启用',
        en: 'always',
      },
    },
    modelValue: 'always',
    image: 'ghostsanitydrain.png',
    i18n: {
      zh: '鬼魂理智值惩罚',
      en: 'Ghost Sanity Drain',
    },
  },
  gnarwail: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'gnarwail.png',
    i18n: {
      zh: '一角鲸',
      en: 'gnarwail',
    },
  },
  goosemoose: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'goosemoose.png',
    i18n: {
      zh: '麋鹿鹅',
      en: 'goosemoose',
    },
  },
  grass: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'grass.png',
    i18n: {
      zh: '草',
      en: 'grass',
    },
  },
  grassgekkos: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'grassgekkos.png',
    i18n: {
      zh: '草壁虎转化',
      en: 'grassgekkos',
    },
  },
  hallowed_nights: {
    configs: ["default", "enabled"],
    modelValue: 'default',
    image: 'hallowed_nights.png',
    i18n: {
      zh: '万圣夜',
      en: 'Hallowed Nights',
    },
  },
  healthpenalty: {
    configs: ["none", "always"],
    customConfigsValue: {
      none: {
        zh: '禁用',
        en: 'none',
      },
      always: {
        zh: '启用',
        en: 'always',
      },
    },
    modelValue: 'always',
    image: 'healthpenalty.png',
    i18n: {
      zh: '血量上限惩罚',
      en: 'healthpenalty',
    },
  },
  hound_mounds: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'hound_mounds.png',
    i18n: {
      zh: '猎犬',
      en: 'hound_mounds',
    },
  },
  houndmound: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'houndmound.png',
    i18n: {
      zh: '猎犬丘',
      en: 'houndmound',
    },
  },
  hounds: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'hounds.png',
    i18n: {
      zh: '猎犬袭击',
      en: 'hounds',
    },
  },
  hunger: {
    configs: ["nonlethal", "default"],
    customConfigsValue: {
      nonlethal: {
        zh: '非致命',
        en: 'nonlethal',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
    },
    modelValue: 'default',
    image: 'hunger.png',
    i18n: {
      zh: '饥饿伤害',
      en: 'hunger',
    },
  },
  hunt: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'hunt.png',
    i18n: {
      zh: '狩猎',
      en: 'hunt',
    },
  },
  junkyard: {
    configs: ["never", "default"],
    modelValue: 'default',
    image: 'junkyard.png',
    i18n: {
      zh: '垃圾场',
      en: 'junkyard',
    },
  },
  klaus: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'klaus.png',
    i18n: {
      zh: '克劳斯',
      en: 'klaus',
    },
  },
  krampus: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'krampus.png',
    i18n: {
      zh: '坎普斯',
      en: 'Krampii',
    },
  },
  lessdamagetaken: {
    configs: ["always", "none", "more"],
    customConfigsValue: {
      always: {
        zh: '较少',
        en: 'always',
      },
      none: {
        zh: '默认',
        en: 'none',
      },
      more: {
        zh: '较多',
        en: 'more',
      },
    },
    modelValue: 'none',
    image: 'lessdamagetaken.png',
    i18n: {
      zh: '受到的伤害',
      en: 'lessdamagetaken',
    },
  },
  liefs: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'liefs.png',
    i18n: {
      zh: '树精守卫',
      en: 'liefs',
    },
  },
  lightcrab_portalrate: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'lightcrab_portalrate.png',
    i18n: {
      zh: '发光蟹',
      en: 'lightcrab_portalrate',
    },
  },
  lightning: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'lightning.png',
    i18n: {
      zh: '闪电',
      en: 'lightning',
    },
  },
  lightninggoat: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'lightninggoat.png',
    i18n: {
      zh: '伏特羊',
      en: 'lightninggoat',
    },
  },
  loop: {
    configs: ["never", "default", "always"],
    customConfigsValue: {
      never: {
        zh: '从不',
        en: 'never',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
      always: {
        zh: '总是',
        en: 'always',
      },
    },
    modelValue: 'default',
    image: 'loop.png',
    i18n: {
      zh: '环形',
      en: 'loop',
    },
  },
  lunarhail_frequency: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'lunarhail_frequency.png',
    i18n: {
      zh: '月亮冰雹',
      en: 'lunarhail_frequency',
    },
  },
  lureplants: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'lureplants.png',
    i18n: {
      zh: '食人花',
      en: 'lureplants',
    },
  },
  malbatross: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'malbatross.png',
    i18n: {
      zh: '邪天翁',
      en: 'malbatross',
    },
  },
  marshbush: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'marshbush.png',
    i18n: {
      zh: '尖刺灌木',
      en: 'marshbush',
    },
  },
  merm: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'merm.png',
    i18n: {
      zh: '漏雨的小屋',
      en: 'merm',
    },
  },
  merms: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'merms.png',
    i18n: {
      zh: '鱼人',
      en: 'merms',
    },
  },
  meteorshowers: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'meteorshowers.png',
    i18n: {
      zh: '流星频率',
      en: 'meteorshowers',
    },
  },
  meteorspawner: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'meteorspawner.png',
    i18n: {
      zh: '流星区域',
      en: 'meteorspawner',
    },
  },
  moles: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'moles.png',
    i18n: {
      zh: '鼹鼠丘',
      en: 'moles',
    },
  },
  moles_setting: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'moles_setting.png',
    i18n: {
      zh: '鼹鼠',
      en: 'moles_setting',
    },
  },
  monkeytail_portalrate: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'monkeytail_portalrate.png',
    i18n: {
      zh: '猴尾草',
      en: 'monkeytail_portalrate',
    },
  },
  moon_berrybush: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'moon_berrybush.png',
    i18n: {
      zh: '石果灌木丛',
      en: 'moon_berrybush',
    },
  },
  moon_bullkelp: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'moon_bullkelp.png',
    i18n: {
      zh: '海岸公牛海带',
      en: 'moon_bullkelp',
    },
  },
  moon_carrot: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'moon_carrot.png',
    i18n: {
      zh: '胡萝卜鼠',
      en: 'moon_carrot',
    },
  },
  moon_fissure: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'moon_fissure.png',
    i18n: {
      zh: '天体裂隙',
      en: 'moon_fissure',
    },
  },
  moon_fruitdragon: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'moon_fruitdragon.png',
    i18n: {
      zh: '沙拉蝾螈',
      en: 'moon_fruitdragon',
    },
  },
  moon_hotspring: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'moon_hotspring.png',
    i18n: {
      zh: '温泉',
      en: 'moon_hotspring',
    },
  },
  moon_rock: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'moon_rock.png',
    i18n: {
      zh: '月亮石',
      en: 'moon_rock',
    },
  },
  moon_sapling: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'moon_sapling.png',
    i18n: {
      zh: '月亮树苗',
      en: 'moon_sapling',
    },
  },
  moon_spider: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'moon_spider.png',
    i18n: {
      zh: '破碎蜘蛛',
      en: 'moon_spider',
    },
  },
  moon_spiders: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'moon_spiders.png',
    i18n: {
      zh: '破碎蜘蛛洞',
      en: 'moon_spiders',
    },
  },
  moon_starfish: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'moon_starfish.png',
    i18n: {
      zh: '海星',
      en: 'moon_starfish',
    },
  },
  moon_tree: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'moon_tree.png',
    i18n: {
      zh: '月树',
      en: 'moon_tree',
    },
  },
  moon_tree_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'moon_tree_regrowth.png',
    i18n: {
      zh: '月树',
      en: 'moon_tree_regrowth',
    },
  },
  mosquitos: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'mosquitos.png',
    i18n: {
      zh: '蚊子',
      en: 'mosquitos',
    },
  },
  mushroom: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'mushroom.png',
    i18n: {
      zh: '蘑菇',
      en: 'mushroom',
    },
  },
  mutated_bird_gestalt: {
    configs: ["never", "default"],
    modelValue: 'default',
    image: 'mutated_bird_gestalt.png',
    i18n: {
      zh: '亮喙鸟',
      en: 'mutated_bird_gestalt',
    },
  },
  mutated_birds: {
    configs: ["never", "default"],
    modelValue: 'default',
    image: 'mutated_birds.png',
    i18n: {
      zh: '变异的鸟',
      en: 'mutated_birds',
    },
  },
  mutated_merm: {
    configs: ["never", "default"],
    modelValue: 'default',
    image: 'mutated_merm.png',
    i18n: {
      zh: '变异鱼人',
      en: 'mutated_merm',
    },
  },
  mutated_hounds: {
    configs: ["never", "default"],
    modelValue: 'default',
    image: 'mutated_hounds.png',
    i18n: {
      zh: '恐怖猎犬',
      en: 'mutated_hounds',
    },
  },
  mutated_deerclops: {
    configs: ["never", "default"],
    modelValue: 'default',
    image: 'mutated_deerclops.png',
    i18n: {
      zh: '晶体独眼巨鹿',
      en: 'mutated_deerclops',
    },
  },
  mutated_buzzard_gestalt: {
    configs: ["never", "default"],
    modelValue: 'default',
    image: 'mutated_buzzard_gestalt.png',
    i18n: {
      zh: '水晶冠秃鹫',
      en: 'mutated_buzzard_gestalt',
    },
  },
  mutated_spiderqueen: {
    configs: ["never", "default"],
    modelValue: 'default',
    image: 'mutated_spiderqueen.png',
    i18n: {
      zh: '破碎蜘蛛洞',
      en: 'mutated_spiderqueen',
    },
  },
  mutated_bearger: {
    configs: ["never", "default"],
    modelValue: 'default',
    image: 'mutated_bearger.png',
    i18n: {
      zh: '装甲熊獾',
      en: 'mutated_bearger',
    },
  },
  mutated_warg: {
    configs: ["never", "default"],
    modelValue: 'default',
    image: 'mutated_warg.png',
    i18n: {
      zh: '附身座狼',
      en: 'mutated_warg',
    },
  },
  ocean_bullkelp: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'ocean_bullkelp.png',
    i18n: {
      zh: '公牛海带',
      en: 'ocean_bullkelp',
    },
  },
  ocean_otterdens: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'ocean_otterdens.png',
    i18n: {
      zh: '水獭掠夺者窝点',
      en: 'ocean_otterdens',
    },
  },
  ocean_seastack: {
    configs: ["ocean_never", "ocean_rare", "ocean_uncommon", "ocean_default", "ocean_often", "ocean_mostly", "ocean_always", "ocean_insane"],
    customConfigsValue: {
      ocean_never: {
        zh: '无',
        en: 'never',
      },
      ocean_rare: {
        zh: '很少',
        en: 'rare',
      },
      ocean_uncommon: {
        zh: '较少',
        en: 'uncommon',
      },
      ocean_default: {
        zh: '默认',
        en: 'Default',
      },
      ocean_often: {
        zh: '较多',
        en: 'often',
      },
      ocean_mostly: {
        zh: '很多',
        en: 'mostly',
      },
      ocean_always: {
        zh: '大量',
        en: 'always',
      },
      ocean_insane: {
        zh: '疯狂',
        en: 'insane',
      },
    },
    modelValue: 'ocean_default',
    image: 'ocean_seastack.png',
    i18n: {
      zh: '海蚀柱',
      en: 'ocean_seastack',
    },
  },
  ocean_shoal: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'ocean_shoal.png',
    i18n: {
      zh: '鱼群',
      en: 'ocean_shoal',
    },
  },
  ocean_waterplant: {
    configs: ["ocean_never", "ocean_rare", "ocean_uncommon", "ocean_default", "ocean_often", "ocean_mostly", "ocean_always", "ocean_insane"],
    customConfigsValue: {
      ocean_never: {
        zh: '无',
        en: 'never',
      },
      ocean_rare: {
        zh: '很少',
        en: 'rare',
      },
      ocean_uncommon: {
        zh: '较少',
        en: 'uncommon',
      },
      ocean_default: {
        zh: '默认',
        en: 'Default',
      },
      ocean_often: {
        zh: '较多',
        en: 'often',
      },
      ocean_mostly: {
        zh: '很多',
        en: 'mostly',
      },
      ocean_always: {
        zh: '大量',
        en: 'always',
      },
      ocean_insane: {
        zh: '疯狂',
        en: 'insane',
      },
    },
    modelValue: 'ocean_default',
    image: 'ocean_waterplant.png',
    i18n: {
      zh: '海草',
      en: 'ocean_waterplant',
    },
  },
  ocean_wobsterden: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'ocean_wobsterden.png',
    i18n: {
      zh: '龙虾窝',
      en: 'ocean_wobsterden',
    },
  },
  otters_setting: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'otters_setting.png',
    i18n: {
      zh: '水獭掠夺者',
      en: 'otters_setting',
    },
  },
  palmcone_seed_portalrate: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'palmcone_seed_portalrate.png',
    i18n: {
      zh: '棕榈松果树芽',
      en: 'palmcone_seed_portalrate',
    },
  },
  palmconetree: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'palmconetree.png',
    i18n: {
      zh: '棕榈松果树',
      en: 'palmconetree',
    },
  },
  palmconetree_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'palmconetree_regrowth.png',
    i18n: {
      zh: '棕榈松果树',
      en: 'palmconetree_regrowth',
    },
  },
  penguins: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'penguins.png',
    i18n: {
      zh: '企鸥',
      en: 'penguins',
    },
  },
  penguins_moon: {
    configs: ["never", "default"],
    modelValue: 'default',
    image: 'penguins_moon.png',
    i18n: {
      zh: '永冻企鸥',
      en: 'penguins_moon',
    },
  },
  perd: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'perd.png',
    i18n: {
      zh: '火鸡',
      en: 'perd',
    },
  },
  petrification: {
    configs: ["none", "few", "default", "many", "max"],
    customConfigsValue: {
      none: {
        zh: '无',
        en: 'none',
      },
      few: {
        zh: '慢',
        en: 'few',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
      many: {
        zh: '快',
        en: 'many',
      },
      max: {
        zh: '极快',
        en: 'max',
      },
    },
    modelValue: 'default',
    image: 'petrification.png',
    i18n: {
      zh: '森林石化',
      en: 'petrification',
    },
  },
  pigs: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'pigs.png',
    i18n: {
      zh: '猪屋',
      en: 'pigs',
    },
  },
  pigs_setting: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'pigs_setting.png',
    i18n: {
      zh: '猪',
      en: 'pigs_setting',
    },
  },
  pirateraids: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'pirateraids.png',
    i18n: {
      zh: '月亮码头海盗',
      en: 'pirateraids',
    },
  },
  ponds: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'ponds.png',
    i18n: {
      zh: '池塘',
      en: 'ponds',
    },
  },
  portal_spawnrate: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'portal_spawnrate.png',
    i18n: {
      zh: '传送频率',
      en: 'portal_spawnrate',
    },
  },
  portalresurection: {
    configs: ["none", "always"],
    customConfigsValue: {
      none: {
        zh: '禁用',
        en: 'none',
      },
      always: {
        zh: '启用',
        en: 'always',
      },
    },
    modelValue: 'none',
    image: 'portalresurection.png',
    i18n: {
      zh: '在绚丽之门复活',
      en: 'Revive At Florid Postern',
    },
  },
  powder_monkey_portalrate: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'powder_monkey_portalrate.png',
    i18n: {
      zh: '火药猴',
      en: 'powder_monkey_portalrate',
    },
  },
  prefabswaps_start: {
    configs: ["classic", "default", "highly random"],
    customConfigsValue: {
      classic: {
        zh: '经典',
        en: 'classic',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
      "highly random": {
        zh: '非常随机',
        en: 'highly random',
      },
    },
    modelValue: 'default',
    image: 'prefabswaps_start.png',
    i18n: {
      zh: '开始资源多样化',
      en: 'prefabswaps_start',
    },
  },
  rabbits: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'rabbits.png',
    i18n: {
      zh: '兔洞',
      en: 'rabbits',
    },
  },
  rabbits_setting: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'rabbits_setting.png',
    i18n: {
      zh: '兔子',
      en: 'rabbits_setting',
    },
  },
  reeds: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'reeds.png',
    i18n: {
      zh: '芦苇',
      en: 'reeds',
    },
  },
  reeds_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'reeds_regrowth.png',
    i18n: {
      zh: '芦苇',
      en: 'reeds_regrowth',
    },
  },
  regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'regrowth.png',
    i18n: {
      zh: '再生速度',
      en: 'regrowth',
    },
  },
  resettime: {
    configs: ["none", "slow", "default", "fast", "always"],
    customConfigsValue: {
      none: {
        zh: '禁用',
        en: 'none',
      },
      slow: {
        zh: '慢',
        en: 'slow',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
      fast: {
        zh: '快',
        en: 'fast',
      },
      always: {
        zh: '立刻',
        en: 'always',
      },
    },
    modelValue: 'none',
    image: 'resettime.png',
    i18n: {
      zh: '死亡重置倒计时',
      en: 'Death Reset timer',
    },
  },
  rifts_enabled: {
    configs: ["never", "default", "always"],
    customConfigsValue: {
      never: {
        zh: '无',
        en: 'never',
      },
      default: {
        zh: '自动检测',
        en: 'Default',
      },
      always: {
        zh: '总是',
        en: 'always',
      },
    },
    modelValue: 'default',
    image: 'rifts_enabled.png',
    i18n: {
      zh: '荒野裂隙',
      en: 'rifts_enabled',
    },
  },
  rifts_frequency: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'rifts_enabled.png',
    i18n: {
      zh: '荒野裂隙频率',
      en: 'rifts_frequency',
    },
  },
  roads: {
    configs: ["never", "default"],
    customConfigsValue: {
      never: {
        zh: '无',
        en: 'never',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
    },
    modelValue: 'default',
    image: 'roads.png',
    i18n: {
      zh: '道路',
      en: 'roads',
    },
  },
  rock: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'rock.png',
    i18n: {
      zh: '巨石',
      en: 'rock',
    },
  },
  rock_ice: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'rock_ice.png',
    i18n: {
      zh: '迷你冰川',
      en: 'rock_ice',
    },
  },
  saltstack_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'saltstack_regrowth.png',
    i18n: {
      zh: '盐堆',
      en: 'saltstack_regrowth',
    },
  },
  sapling: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'sapling.png',
    i18n: {
      zh: '树苗',
      en: 'sapling',
    },
  },
  season_start: {
    configs: ["default", "winter", "spring", "summer", "autumn|spring", "winter|summer", "autumn|winter|spring|summer"],
    customConfigsValue: {
      default: {
        zh: '秋',
        en: 'default',
      },
      winter: {
        zh: '冬',
        en: 'winter',
      },
      spring: {
        zh: '春',
        en: 'spring',
      },
      summer: {
        zh: '夏',
        en: 'summer',
      },
      "autumn|spring": {
        zh: '春或秋',
        en: 'autumn|spring',
      },
      "winter|summer": {
        zh: '冬季或夏季',
        en: 'winter|summer',
      },
      "autumn|winter|spring|summer": {
        zh: '随机',
        en: 'autumn|winter|spring|summer',
      },
    },
    modelValue: 'default',
    image: 'season_start.png',
    i18n: {
      zh: '起始季节',
      en: 'season_start',
    },
  },
  seasonalstartingitems: {
    configs: ["never", "default"],
    customConfigsValue: {
      never: {
        zh: '无',
        en: 'None',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
    },
    modelValue: 'default',
    image: 'seasonalstartingitems.png',
    i18n: {
      zh: '季节起始物品',
      en: 'Seasonal Starting Items',
    },
  },
  shadowcreatures: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'shadowcreatures.png',
    i18n: {
      zh: '理智怪兽',
      en: 'shadowcreatures',
    },
  },
  sharkboi: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'sharkboi.png',
    i18n: {
      zh: '大霜鲨',
      en: 'sharkboi',
    },
  },
  sharks: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'sharks.png',
    i18n: {
      zh: '鲨鱼',
      en: 'sharks',
    },
  },
  spawnmode: {
    configs: ["fixed", "scatter"],
    customConfigsValue: {
      fixed: {
        zh: '绚丽之门',
        en: 'fixed',
      },
      scatter: {
        zh: '随机',
        en: 'scatter',
      },
    },
    modelValue: 'fixed',
    image: 'spawnmode.png',
    i18n: {
      zh: '出生模式',
      en: 'Spawn Mode',
    },
  },
  spawnprotection: {
    configs: ["never", "default", "always"],
    customConfigsValue: {
      never: {
        zh: '无',
        en: 'None',
      },
      default: {
        zh: '自动检测',
        en: 'Auto Detect',
      },
      always: {
        zh: '总是',
        en: 'Always',
      },
    },
    modelValue: 'default',
    image: 'spawnprotection.png',
    i18n: {
      zh: '防骚扰出生保护',
      en: 'Griefer Spawn Protection',
    },
  },
  specialevent: {
    configs: ["none", "default"],
    customConfigsValue: {
      none: {
        zh: '无',
        en: 'none',
      },
      default: {
        zh: '自动',
        en: 'default',
      },
    },
    modelValue: 'default',
    image: 'specialevent.png',
    i18n: {
      zh: '活动',
      en: 'Events',
    },
  },
  spider_warriors: {
    configs: ["never", "default"],
    customConfigsValue: {
      never: {
        zh: '无',
        en: 'never',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
    },
    modelValue: 'default',
    image: 'spider_warriors.png',
    i18n: {
      zh: '蜘蛛战士',
      en: 'spider_warriors',
    },
  },
  spiderqueen: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'spiderqueen.png',
    i18n: {
      zh: '蜘蛛女王',
      en: 'spiderqueen',
    },
  },
  spiders: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'spiders.png',
    i18n: {
      zh: '蜘蛛巢',
      en: 'spiders',
    },
  },
  spiders_setting: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'spiders_setting.png',
    i18n: {
      zh: '蜘蛛',
      en: 'spiders_setting',
    },
  },
  spring: {
    configs: ["noseason", "veryshortseason", "shortseason", "default", "longseason", "verylongseason", "random"],
    modelValue: 'default',
    image: 'spring.png',
    i18n: {
      zh: '春',
      en: 'Spring',
    },
  },
  squid: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'squid.png',
    i18n: {
      zh: '鱿鱼',
      en: 'squid',
    },
  },
  stageplays: {
    configs: ["never", "default"],
    customConfigsValue: {
      never: {
        zh: '无',
        en: 'never',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
    },
    modelValue: 'default',
    image: 'stageplays.png',
    i18n: {
      zh: '舞台剧',
      en: 'stageplays',
    },
  },
  start_location: {
    configs: ["plus", "default", "darkness"],
    customConfigsValue: {
      plus: {
        zh: '额外资源',
        en: 'plus',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
      darkness: {
        zh: '黑暗',
        en: 'darkness',
      },
    },
    modelValue: 'default',
    image: 'start_location.png',
    i18n: {
      zh: '出生点',
      en: 'start_location',
    },
  },
  summer: {
    configs: ["noseason", "veryshortseason", "shortseason", "default", "longseason", "verylongseason", "random"],
    modelValue: 'default',
    image: 'summer.png',
    i18n: {
      zh: '夏',
      en: 'Summer',
    },
  },
  summerhounds: {
    configs: ["never", "default"],
    customConfigsValue: {
      never: {
        zh: '无',
        en: 'never',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
    },
    modelValue: 'default',
    image: 'summerhounds.png',
    i18n: {
      zh: '火猎犬群',
      en: 'summerhounds',
    },
  },
  tallbirds: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'tallbirds.png',
    i18n: {
      zh: '高脚鸟',
      en: 'tallbirds',
    },
  },
  task_set: {
    configs: ["default", "classic"],
    customConfigsValue: {
      default: {
        zh: '联机版',
        en: 'default',
      },
      classic: {
        zh: '经典',
        en: 'classic',
      },
    },
    modelValue: 'default',
    image: 'task_set.png',
    i18n: {
      zh: '生物群落',
      en: 'task_set',
    },
  },
  temperaturedamage: {
    configs: ["nonlethal", "default"],
    customConfigsValue: {
      nonlethal: {
        zh: '非致命',
        en: 'nonlethal',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
    },
    modelValue: 'default',
    image: 'temperaturedamage.png',
    i18n: {
      zh: '温度伤害',
      en: 'temperaturedamage',
    },
  },
  tentacles: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'tentacles.png',
    i18n: {
      zh: '触手',
      en: 'tentacles',
    },
  },
  terrariumchest: {
    configs: ["never", "default"],
    customConfigsValue: {
      never: {
        zh: '无',
        en: 'never',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
    },
    modelValue: 'default',
    image: 'terrariumchest.png',
    i18n: {
      zh: '盒中泰拉',
      en: 'terrariumchest',
    },
  },
  touchstone: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'touchstone.png',
    i18n: {
      zh: '试金石',
      en: 'touchstone',
    },
  },
  trees: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'trees.png',
    i18n: {
      zh: '树（所有）',
      en: 'trees',
    },
  },
  tree_rock: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'tree_rock_regrowth.png',
    i18n: {
      zh: '巨石枝',
      en: 'tree_rock',
    },
  },
  tree_rock_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'tree_rock_regrowth.png',
    i18n: {
      zh: '巨石枝',
      en: 'tree_rock_regrowth',
    },
  },
  tumbleweed: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'tumbleweed.png',
    i18n: {
      zh: '风滚草',
      en: 'tumbleweed',
    },
  },
  twiggytrees_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'twiggytrees_regrowth.png',
    i18n: {
      zh: '多枝树',
      en: 'twiggytrees_regrowth',
    },
  },
  walrus: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'walrus.png',
    i18n: {
      zh: '海象营地',
      en: 'walrus',
    },
  },
  walrus_setting: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'walrus_setting.png',
    i18n: {
      zh: '海象',
      en: 'walrus_setting',
    },
  },
  wasps: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'wasps.png',
    i18n: {
      zh: '杀人蜂',
      en: 'wasps',
    },
  },
  weather: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'weather.png',
    i18n: {
      zh: '雨',
      en: 'weather',
    },
  },
  wildfires: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'wildfires.png',
    i18n: {
      zh: '野火',
      en: 'wildfires',
    },
  },
  winter: {
    configs: ["noseason", "veryshortseason", "shortseason", "default", "longseason", "verylongseason", "random"],
    modelValue: 'default',
    image: 'winter.png',
    i18n: {
      zh: '冬',
      en: 'Winter',
    },
  },
  winterhounds: {
    configs: ["never", "default"],
    customConfigsValue: {
      never: {
        zh: '无',
        en: 'never',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
    },
    modelValue: 'default',
    image: 'winterhounds.png',
    i18n: {
      zh: '冰猎犬群',
      en: 'winterhounds',
    },
  },
  winters_feast: {
    configs: ["default", "enabled"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      enabled: {
        zh: '总是',
        en: 'enabled',
      },
    },
    modelValue: 'default',
    image: 'winters_feast.png',
    i18n: {
      zh: '冬季盛宴',
      en: 'Winter\'s Feast',
    },
  },
  wobsters: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'wobsters.png',
    i18n: {
      zh: '龙虾',
      en: 'wobsters',
    },
  },
  world_size: {
    configs: ["small", "medium", "default", "huge"],
    customConfigsValue: {
      small: {
        zh: '小',
        en: 'small',
      },
      medium: {
        zh: '中',
        en: 'medium',
      },
      default: {
        zh: '大',
        en: 'default',
      },
      huge: {
        zh: '巨大',
        en: 'huge',
      },
    },
    modelValue: 'default',
    image: 'world_size.png',
    i18n: {
      zh: '世界大小',
      en: 'world_size',
    },
  },
  year_of_the_beefalo: {
    configs: ["default", "enabled"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      enabled: {
        zh: '总是',
        en: 'enabled',
      },
    },
    modelValue: 'default',
    image: 'year_of_the_beefalo.png',
    i18n: {
      zh: '皮弗娄牛之年',
      en: 'Year Of The Beefalo',
    },
  },
  year_of_the_bunnyman: {
    configs: ["default", "enabled"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      enabled: {
        zh: '总是',
        en: 'enabled',
      },
    },
    modelValue: 'default',
    image: 'year_of_the_bunnyman.png',
    i18n: {
      zh: '兔人之年',
      en: 'Year Of The Bunnyman',
    },
  },
  year_of_the_carrat: {
    configs: ["default", "enabled"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      enabled: {
        zh: '总是',
        en: 'enabled',
      },
    },
    modelValue: 'default',
    image: 'year_of_the_carrat.png',
    i18n: {
      zh: '胡萝卜鼠之年',
      en: 'Year Of The Carrat',
    },
  },
  year_of_the_catcoon: {
    configs: ["default", "enabled"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      enabled: {
        zh: '总是',
        en: 'enabled',
      },
    },
    modelValue: 'default',
    image: 'year_of_the_catcoon.png',
    i18n: {
      zh: '浣猫之年',
      en: 'Year Of The Catcoon',
    },
  },
  year_of_the_dragonfly: {
    configs: ["default", "enabled"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      enabled: {
        zh: '总是',
        en: 'enabled',
      },
    },
    modelValue: 'default',
    image: 'year_of_the_dragonfly.png',
    i18n: {
      zh: '龙蝇之年',
      en: 'Year Of The Dragonfly',
    },
  },
  year_of_the_gobbler: {
    configs: ["default", "enabled"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      enabled: {
        zh: '总是',
        en: 'enabled',
      },
    },
    modelValue: 'default',
    image: 'year_of_the_gobbler.png',
    i18n: {
      zh: '火鸡之年',
      en: 'Year Of The Gobbler',
    },
  },
  year_of_the_knight: {
    configs: ["default", "enabled"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      enabled: {
        zh: '总是',
        en: 'enabled',
      },
    },
    modelValue: 'default',
    image: 'year_of_the_knight.png',
    i18n: {
      zh: '发条骑士之年',
      en: 'Year Of The Knight',
    },
  },
  year_of_the_pig: {
    configs: ["default", "enabled"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      enabled: {
        zh: '总是',
        en: 'enabled',
      },
    },
    modelValue: 'default',
    image: 'year_of_the_pig.png',
    i18n: {
      zh: '猪王之年',
      en: 'Year Of The Pig King',
    },
  },
  year_of_the_snake: {
    configs: ["default", "enabled"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      enabled: {
        zh: '总是',
        en: 'enabled',
      },
    },
    modelValue: 'default',
    image: 'year_of_the_snake.png',
    i18n: {
      zh: '洞穴蠕虫之年',
      en: 'Year Of The Depths Worm',
    },
  },
  year_of_the_varg: {
    configs: ["default", "enabled"],
    customConfigsValue: {
      default: {
        zh: '默认',
        en: 'Default',
      },
      enabled: {
        zh: '总是',
        en: 'enabled',
      },
    },
    modelValue: 'default',
    image: 'year_of_the_varg.png',
    i18n: {
      zh: '座狼之年',
      en: 'Year Of The Varg',
    },
  },
  acidrain_enabled: {
    configs: ["none", "always"],
    customConfigsValue: {
      none: {
        zh: '禁用',
        en: 'none',
      },
      always: {
        zh: '启用',
        en: 'always',
      },
    },
    modelValue: 'none',
    image: 'acidrain_enabled.png',
    i18n: {
      zh: '酸雨',
      en: 'acidrain_enabled',
    },
  },
  atriumgate: {
    configs: ["veryslow", "slow", "default", "fast", "veryfast"],
    customConfigsValue: {
      veryslow: {
        zh: '极慢',
        en: 'veryslow',
      },
      slow: {
        zh: '慢',
        en: 'slow',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
      fast: {
        zh: '快',
        en: 'fast',
      },
      veryfast: {
        zh: '极快',
        en: 'veryfast',
      },
    },
    modelValue: 'default',
    image: 'atriumgate.png',
    i18n: {
      zh: '远古大门',
      en: 'atriumgate',
    },
  },
  banana: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'banana.png',
    i18n: {
      zh: '香蕉',
      en: 'banana',
    },
  },
  bats: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'bats.png',
    i18n: {
      zh: '蝙蝠',
      en: 'bats',
    },
  },
  bunnymen: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'bunnymen.png',
    i18n: {
      zh: '兔屋',
      en: 'bunnymen',
    },
  },
  cave_ponds: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'cave_ponds.png',
    i18n: {
      zh: '池塘',
      en: 'cave_ponds',
    },
  },
  cave_spiders: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'cave_spiders.png',
    i18n: {
      zh: '蛛网岩',
      en: 'cave_spiders',
    },
  },
  cavelight: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'cavelight.png',
    i18n: {
      zh: '洞穴光照',
      en: 'cavelight',
    },
  },
  chest_mimics: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'chest_mimics.png',
    i18n: {
      zh: '暴躁箱子',
      en: 'chest_mimics',
    },
  },
  daywalker: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'daywalker.png',
    i18n: {
      zh: '梦魇疯猪',
      en: 'daywalker',
    },
  },
  dustmoths: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'dustmoths.png',
    i18n: {
      zh: '尘蛾',
      en: 'dustmoths',
    },
  },
  earthquakes: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'earthquakes.png',
    i18n: {
      zh: '地震',
      en: 'earthquakes',
    },
  },
  fern: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'fern.png',
    i18n: {
      zh: '洞穴蕨类',
      en: 'fern',
    },
  },
  fissure: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'fissure.png',
    i18n: {
      zh: '梦魇裂隙',
      en: 'fissure',
    },
  },
  flower_cave: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'flower_cave.png',
    i18n: {
      zh: '荧光花',
      en: 'flower_cave',
    },
  },
  itemmimics: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'itemmimics.png',
    i18n: {
      zh: '拟态蠕虫',
      en: 'itemmimics',
    },
  },
  flower_cave_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'flower_cave_regrowth.png',
    i18n: {
      zh: '荧光花',
      en: 'flower_cave_regrowth',
    },
  },
  lichen: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'lichen.png',
    i18n: {
      zh: '苔藓',
      en: 'lichen',
    },
  },
  lightflier_flower_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'lightflier_flower_regrowth.png',
    i18n: {
      zh: '光虫花',
      en: 'lightflier_flower_regrowth',
    },
  },
  lightfliers: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'lightfliers.png',
    i18n: {
      zh: '球状光虫',
      en: 'lightfliers',
    },
  },
  molebats: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'molebats.png',
    i18n: {
      zh: '裸鼹蝠',
      en: 'molebats',
    },
  },
  monkey: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'monkey.png',
    i18n: {
      zh: '穴居猴桶',
      en: 'monkey',
    },
  },
  monkey_setting: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'monkey_setting.png',
    i18n: {
      zh: '穴居猴',
      en: 'monkey_setting',
    },
  },
  mushgnome: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'mushgnome.png',
    i18n: {
      zh: '蘑菇地精',
      en: 'mushgnome',
    },
  },
  mushtree: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'mushtree.png',
    i18n: {
      zh: '蘑菇树',
      en: 'mushtree',
    },
  },
  mushtree_moon_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'mushtree_moon_regrowth.png',
    i18n: {
      zh: '月亮蘑菇树',
      en: 'mushtree_moon_regrowth',
    },
  },
  mushtree_regrowth: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'mushtree_regrowth.png',
    i18n: {
      zh: '蘑菇树',
      en: 'mushtree_regrowth',
    },
  },
  nightmarecreatures: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'nightmarecreatures.png',
    i18n: {
      zh: '遗迹梦魇',
      en: 'nightmarecreatures',
    },
  },
  rifts_enabled_cave: {
    configs: ["never", "default", "always"],
    customConfigsValue: {
      never: {
        zh: '无',
        en: 'never',
      },
      default: {
        zh: '自动检测',
        en: 'Default',
      },
      always: {
        zh: '总是',
        en: 'always',
      },
    },
    modelValue: 'default',
    image: 'rifts_enabled_cave.png',
    i18n: {
      zh: '荒野裂隙',
      en: 'rifts_enabled_cave',
    },
  },
  rifts_frequency_cave: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'rifts_frequency_cave.png',
    i18n: {
      zh: '荒野裂隙频率',
      en: 'rifts_frequency_cave',
    },
  },
  rocky: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'rocky.png',
    i18n: {
      zh: '石虾',
      en: 'rocky',
    },
  },
  rocky_setting: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'rocky_setting.png',
    i18n: {
      zh: '石虾',
      en: 'rocky_setting',
    },
  },
  slurper: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'slurper.png',
    i18n: {
      zh: '啜食者',
      en: 'slurper',
    },
  },
  slurtles: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'slurtles.png',
    i18n: {
      zh: '蛞蝓龟窝',
      en: 'slurtles',
    },
  },
  slurtles_setting: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'slurtles_setting.png',
    i18n: {
      zh: '蛞蝓龟',
      en: 'slurtles_setting',
    },
  },
  snurtles: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'snurtles.png',
    i18n: {
      zh: '蜗牛龟',
      en: 'snurtles',
    },
  },
  spider_dropper: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'spider_dropper.png',
    i18n: {
      zh: '穴居悬蛛',
      en: 'spider_dropper',
    },
  },
  spider_hider: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'spider_hider.png',
    i18n: {
      zh: '洞穴蜘蛛',
      en: 'spider_hider',
    },
  },
  spider_spitter: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'spider_spitter.png',
    i18n: {
      zh: '喷射蜘蛛',
      en: 'spider_spitter',
    },
  },
  toadstool: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'toadstool.png',
    i18n: {
      zh: '毒菌蟾蜍',
      en: 'toadstool',
    },
  },
  wormattacks: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'wormattacks.png',
    i18n: {
      zh: '洞穴蠕虫攻击',
      en: 'wormattacks',
    },
  },
  wormattacks_boss: {
    configs: ["never", "rare", "default", "often", "always"],
    modelValue: 'default',
    image: 'wormattacks_boss.png',
    i18n: {
      zh: '大蠕虫',
      en: 'wormattacks_boss',
    },
  },
  wormlights: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'wormlights.png',
    i18n: {
      zh: '发光浆果',
      en: 'wormlights',
    },
  },
  worms: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'worms.png',
    i18n: {
      zh: '洞穴蠕虫',
      en: 'worms',
    },
  },
  wanderingtrader_enabled: {
    configs: ["none", "always"],
    modelValue: 'always',
    customConfigsValue: {
      none: {
        zh: '禁用',
        en: 'Disable',
      },
      always: {
        zh: '启用',
        en: 'Enable',
      },
    },
    image: 'wanderingtrader_enabled.png',
    i18n: {
      zh: '流浪商人',
      en: 'Wanderingtrader',
    },
  },
  balatro: {
    configs: ["never", "default"],
    modelValue: 'default',
    image: 'balatro.png',
    i18n: {
      zh: '小丑',
      en: 'Balatro',
    },
  },
}

// 洞穴 - 世界生成 - 世界
const caveOverrideWorldGenerationWorld = {
  start_location: {
    configs: ["caves"],
    customConfigsValue: {
      caves: {
        zh: '洞穴',
        en: 'caves',
      },
    },
    modelValue: 'caves',
    image: 'start_location.png',
    i18n: {
      zh: '出生点',
      en: 'start_location',
    },
  },
  task_set: {
    configs: ["cave_default"],
    customConfigsValue: {
      cave_default: {
        zh: '地下',
        en: 'cave_default',
      },
    },
    modelValue: 'cave_default',
    image: 'task_set.png',
    i18n: {
      zh: '生物群落',
      en: 'task_set',
    },
  },
  world_size: {
    configs: ["small", "medium", "default", "huge"],
    customConfigsValue: {
      small: {
        zh: '小',
        en: 'small',
      },
      medium: {
        zh: '中',
        en: 'medium',
      },
      default: {
        zh: '大',
        en: 'default',
      },
      huge: {
        zh: '巨大',
        en: 'huge',
      },
    },
    modelValue: 'default',
    image: 'world_size.png',
    i18n: {
      zh: '世界大小',
      en: 'world_size',
    },
  },
  branching: {
    configs: ["never", "least", "default", "most", "random"],
    modelValue: 'default',
    image: 'branching.png',
    i18n: {
      zh: '分支',
      en: 'branching',
    },
  },
  loop: {
    configs: ["never", "default", "always"],
    customConfigsValue: {
      never: {
        zh: '从不',
        en: 'never',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
      always: {
        zh: '总是',
        en: 'always',
      },
    },
    modelValue: 'default',
    image: 'loop.png',
    i18n: {
      zh: '环形',
      en: 'loop',
    },
  },
  touchstone: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'touchstone.png',
    i18n: {
      zh: '试金石',
      en: 'touchstone',
    },
  },
  cavelight: {
    configs: ["never", "veryslow", "slow", "default", "fast", "veryfast"],
    modelValue: 'default',
    image: 'cavelight.png',
    i18n: {
      zh: '洞穴光照',
      en: 'cavelight',
    },
  },
  boons: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'boons.png',
    i18n: {
      zh: '失败的冒险家',
      en: 'boons',
    },
  },
  prefabswaps_start: {
    configs: ["classic", "default", "highly random"],
    customConfigsValue: {
      classic: {
        zh: '经典',
        en: 'classic',
      },
      default: {
        zh: '默认',
        en: 'Default',
      },
      "highly random": {
        zh: '非常随机',
        en: 'highly random',
      },
    },
    modelValue: 'default',
    image: 'prefabswaps_start.png',
    i18n: {
      zh: '开始资源多样化',
      en: 'prefabswaps_start',
    },
  },
  cave_ponds: {
    configs: ["never", "rare", "uncommon", "default", "often", "mostly", "always", "insane"],
    modelValue: 'default',
    image: 'ponds.png',
    i18n: {
      zh: '池塘',
      en: 'ponds',
    },
  },
}

const configsMap = {
  never: {
    zh: '无',
    en: 'None',
  },
  rare: {
    zh: '很少',
    en: 'Little',
  },
  uncommon: {
    zh: '较少',
    en: 'Less',
  },
  default: {
    zh: '默认',
    en: 'Default',
  },
  often: {
    zh: '较多',
    en: 'More',
  },
  mostly: {
    zh: '很多',
    en: 'Lots',
  },
  always: {
    zh: '大量',
    en: 'Tons',
  },
  insane: {
    zh: '疯狂',
    en: 'Insane',
  },
  noseason: {
    zh: '无',
    en: 'None',
  },
  veryshortseason: {
    zh: '很短',
    en: 'Very Short',
  },
  shortseason: {
    zh: '短',
    en: 'Short',
  },
  longseason: {
    zh: '长',
    en: 'Long',
  },
  verylongseason: {
    zh: '很长',
    en: 'Very Long',
  },
  random: {
    zh: '随机',
    en: 'Random',
  },
  least: {
    zh: '最少',
    en: 'Least',
  },
  most: {
    zh: '最多',
    en: 'Most',
  },
  veryslow: {
    zh: '极慢',
    en: 'Very Slow',
  },
  slow: {
    zh: '慢',
    en: 'Slow',
  },
  fast: {
    zh: '快',
    en: 'Fast',
  },
  veryfast: {
    zh: '极快',
    en: 'Very Fast',
  },
  enabled: {
    zh: '总是',
    en: 'enabled',
  },
}

const groundWorldRule = {
  global: [
    'specialevent',
    'autumn',
    'winter',
    'spring',
    'summer',
    'day',
    'spawnmode',
    'ghostenabled',
    'portalresurection',
    'ghostsanitydrain',
    'resettime',
    'beefaloheat',
    'krampus',
  ],
  events: [
    'crow_carnival',
    'hallowed_nights',
    'winters_feast',
    'year_of_the_gobbler',
    'year_of_the_varg',
    'year_of_the_pig',
    'year_of_the_carrat',
    'year_of_the_beefalo',
    'year_of_the_catcoon',
    'year_of_the_bunnyman',
    'year_of_the_dragonfly',
    'year_of_the_snake',
    'year_of_the_knight',
  ],
  survivors: [
    'extrastartingitems',
    'seasonalstartingitems',
    'spawnprotection',
    'dropeverythingondespawn',
    'healthpenalty',
    'lessdamagetaken',
    'temperaturedamage',
    'hunger',
    'darkness',
    'shadowcreatures',
    'brightmarecreatures',
  ],
  world: [
    'hounds',
    'winterhounds',
    'summerhounds',
    'lunarhail_frequency',
    'petrification',
    'meteorshowers',
    'wanderingtrader_enabled',
    'hunt',
    'rifts_enabled',
    'rifts_frequency',
    'alternatehunt',
    'wildfires',
    'lightning',
    'weather',
    'frograin',
  ],
  resourceRegrowth: [
    'regrowth',
    'flowers_regrowth',
    'moon_tree_regrowth',
    'saltstack_regrowth',
    'reeds_regrowth',
    'cactus_regrowth',
    'twiggytrees_regrowth',
    'evergreen_regrowth',
    'deciduoustree_regrowth',
    'carrots_regrowth',
    'basicresource_regrowth',
    'palmconetree_regrowth',
  ],
  unnaturalPortalResource: [
    'lightcrab_portalrate',
    'powder_monkey_portalrate',
    'monkeytail_portalrate',
    'bananabush_portalrate',
    'portal_spawnrate',
    'palmcone_seed_portalrate',
  ],
  creatures: [
    'pigs_setting',
    'birds',
    'penguins',
    'bunnymen_setting',
    'rabbits_setting',
    'catcoons',
    'perd',
    'bees_setting',
    'butterfly',
    'fishschools',
    'moles_setting',
    'wobsters',
    'gnarwail',
    'otters_setting',
    'grassgekkos',
  ],
  hostileCreatures: [
    'pirateraids',
    'wasps',
    'walrus_setting',
    'hound_mounds',
    'mosquitos',
    'spiders_setting',
    'spider_warriors',
    'bats_setting',
    'frogs',
    'lureplants',
    'cookiecutters',
    'merms',
    'squid',
    'sharks',
  ],
  giants: [
    'bearger',
    'beequeen',
    'dragonfly',
    'klaus',
    'sharkboi',
    'crabking',
    'fruitfly',
    'malbatross',
    'goosemoose',
    'eyeofterror',
    'daywalker2',
    'liefs',
    'deciduousmonster',
    'deerclops',
    'antliontribute',
    'spiderqueen',
  ],
  moonMutated: [
    'mutated_bird_gestalt',
    'mutated_birds',
    'mutated_merm',
    'mutated_hounds',
    'mutated_deerclops',
    'mutated_buzzard_gestalt',
    'penguins_moon',
    'moon_spider',
    'mutated_spiderqueen',
    'mutated_bearger',
    'mutated_warg',
  ],
}

const groundWorldGeneration = {
  global: [
    'season_start',
  ],
  world: [
    'task_set',
    'start_location',
    'world_size',
    'branching',
    'loop',
    'roads',
    'touchstone',
    'boons',
    'prefabswaps_start',
    'junkyard',
    'moon_fissure',
    'balatro',
    'terrariumchest',
    'stageplays',
  ],
  resources: [
    'grass',
    'rock',
    'moon_tree',
    'sapling',
    'ponds',
    'moon_starfish',
    'moon_hotspring',
    'flint',
    'reeds',
    'mushroom',
    'cactus',
    'moon_rock',
    'berrybush',
    'ocean_seastack',
    'carrot',
    'tumbleweed',
    'ocean_bullkelp',
    'marshbush',
    'moon_sapling',
    'meteorspawner',
    'rock_ice',
    'trees',
    'palmconetree',
    'moon_berrybush',
    'flowers',
    'moon_bullkelp',
  ],
  creaturesAndSpawners: [
    'rabbits',
    'pigs',
    'buzzard',
    'ocean_shoal',
    'lightninggoat',
    'moles',
    'ocean_wobsterden',
    'moon_fruitdragon',
    'beefalo',
    'catcoon',
    'moon_carrot',
    'bees',
    'ocean_otterdens',
  ],
  hostileCreaturesAndSpawners: [
    'ocean_waterplant',
    'tentacles',
    'houndmound',
    'spiders',
    'tallbirds',
    'chess',
    'walrus',
    'angrybees',
    'merm',
    'moon_spiders',
  ],
}

const cavesWorldRule = {
  world: [
    'weather',
    'earthquakes',
    'acidrain_enabled',
    'wormattacks_boss',
    'rifts_enabled_cave',
    'atriumgate',
    'wormattacks',
    'rifts_frequency_cave',
  ],
  resourceRegrowth: [
    'regrowth',
    'lightflier_flower_regrowth',
    'flower_cave_regrowth',
    'mushtree_regrowth',
    'mushtree_moon_regrowth',
    'evergreen_regrowth',
    'reeds_regrowth',
    'tree_rock_regrowth',
    'twiggytrees_regrowth',
  ],
  creatures: [
    'pigs_setting',
    'bunnymen_setting',
    'dustmoths',
    'rocky_setting',
    'moles_setting',
    'monkey_setting',
    'slurtles_setting',
    'snurtles',
    'lightfliers',
    'mushgnome',
    'grassgekkos',
  ],
  hostileCreatures: [
    'spiders_setting',
    'bats_setting',
    'merms',
    'molebats',
    'spider_spitter',
    'itemmimics',
    'chest_mimics',
    'spider_hider',
    'spider_dropper',
    'spider_warriors',
    'nightmarecreatures',
  ],
  giants: [
    'fruitfly', 'liefs', 'daywalker', 'toadstool', 'spiderqueen',
  ],
  moonMutated: [
    'mutated_birds', 'mutated_merm', 'moon_spider', 'mutated_spiderqueen',
  ],
}

const cavesWorldGeneration = {
  world: [
    'task_set',
    'start_location',
    'world_size',
    'branching',
    'loop',
    'touchstone',
    'cavelight',
    'boons',
    'prefabswaps_start',
  ],
  resources: [
    'grass',
    'rock',
    'sapling',
    'cave_ponds',
    'flint',
    'reeds',
    'lichen',
    'mushroom',
    'banana',
    'berrybush',
    'flower_cave',
    'mushtree',
    'wormlights',
    'marshbush',
    'fern',
    'trees',
    'tree_rock',
  ],
  creaturesAndSpawners: [
    'bunnymen', 'rocky', 'slurper', 'monkey', 'slurtles',
  ],
  hostileCreaturesAndSpawners: [
    'bats',
    'tentacles',
    'cave_spiders',
    'spiders',
    'chess',
    'fissure',
    'worms',
  ],
}

// endless
const endless = {
  master: `return {
  desc="永不结束的饥荒沙盒模式。\\
永远可以在绚丽之门复活。",
  hideminimap=false,
  id="ENDLESS",
  location="forest",
  max_playlist_position=999,
  min_playlist_position=0,
  name="无尽",
  numrandom_set_pieces=4,
  override_level_string=false,
  overrides={
    alternatehunt="default",
    angrybees="default",
    antliontribute="default",
    autumn="default",
    balatro="default",
    bananabush_portalrate="default",
    basicresource_regrowth="always",
    bats_setting="default",
    bearger="default",
    beefalo="default",
    beefaloheat="default",
    beequeen="default",
    bees="default",
    bees_setting="default",
    berrybush="default",
    birds="default",
    boons="default",
    branching="default",
    brightmarecreatures="default",
    bunnymen_setting="default",
    butterfly="default",
    buzzard="default",
    cactus="default",
    cactus_regrowth="default",
    carrot="default",
    carrots_regrowth="default",
    catcoon="default",
    catcoons="default",
    chess="default",
    cookiecutters="default",
    crabking="default",
    crow_carnival="default",
    darkness="default",
    day="default",
    daywalker2="default",
    deciduousmonster="default",
    deciduoustree_regrowth="default",
    deerclops="default",
    dragonfly="default",
    dropeverythingondespawn="default",
    evergreen_regrowth="default",
    extrastartingitems="default",
    eyeofterror="default",
    fishschools="default",
    flint="default",
    flowers="default",
    flowers_regrowth="default",
    frograin="default",
    frogs="default",
    fruitfly="default",
    ghostenabled="always",
    ghostsanitydrain="none",
    gnarwail="default",
    goosemoose="default",
    grass="default",
    grassgekkos="default",
    hallowed_nights="default",
    has_ocean=true,
    healthpenalty="always",
    hound_mounds="default",
    houndmound="default",
    hounds="default",
    hunger="default",
    hunt="default",
    junkyard="default",
    keep_disconnected_tiles=true,
    klaus="default",
    krampus="default",
    layout_mode="LinkNodesByKeys",
    lessdamagetaken="none",
    liefs="default",
    lightcrab_portalrate="default",
    lightning="default",
    lightninggoat="default",
    loop="default",
    lunarhail_frequency="default",
    lureplants="default",
    malbatross="default",
    marshbush="default",
    merm="default",
    merms="default",
    meteorshowers="default",
    meteorspawner="default",
    moles="default",
    moles_setting="default",
    monkeytail_portalrate="default",
    moon_berrybush="default",
    moon_bullkelp="default",
    moon_carrot="default",
    moon_fissure="default",
    moon_fruitdragon="default",
    moon_hotspring="default",
    moon_rock="default",
    moon_sapling="default",
    moon_spider="default",
    moon_spiders="default",
    moon_starfish="default",
    moon_tree="default",
    moon_tree_regrowth="default",
    mosquitos="default",
    mushroom="default",
    mutated_bearger="default",
    mutated_bird_gestalt="default",
    mutated_birds="default",
    mutated_buzzard_gestalt="default",
    mutated_deerclops="default",
    mutated_hounds="default",
    mutated_merm="default",
    mutated_spiderqueen="default",
    mutated_warg="default",
    no_joining_islands=true,
    no_wormholes_to_disconnected_tiles=true,
    ocean_bullkelp="default",
    ocean_otterdens="default",
    ocean_seastack="ocean_default",
    ocean_shoal="default",
    ocean_waterplant="ocean_default",
    ocean_wobsterden="default",
    otters_setting="default",
    palmcone_seed_portalrate="default",
    palmconetree="default",
    palmconetree_regrowth="default",
    penguins="default",
    penguins_moon="default",
    perd="default",
    petrification="default",
    pigs="default",
    pigs_setting="default",
    pirateraids="default",
    ponds="default",
    portal_spawnrate="default",
    portalresurection="always",
    powder_monkey_portalrate="default",
    prefabswaps_start="default",
    rabbits="default",
    rabbits_setting="default",
    reeds="default",
    reeds_regrowth="default",
    regrowth="default",
    resettime="none",
    rifts_enabled="default",
    rifts_frequency="default",
    roads="default",
    rock="default",
    rock_ice="default",
    saltstack_regrowth="default",
    sapling="default",
    season_start="default",
    seasonalstartingitems="default",
    shadowcreatures="default",
    sharkboi="default",
    sharks="default",
    spawnmode="fixed",
    spawnprotection="default",
    specialevent="default",
    spider_warriors="default",
    spiderqueen="default",
    spiders="default",
    spiders_setting="default",
    spring="default",
    squid="default",
    stageplays="default",
    start_location="default",
    summer="default",
    summerhounds="default",
    tallbirds="default",
    task_set="default",
    temperaturedamage="default",
    tentacles="default",
    terrariumchest="default",
    touchstone="default",
    trees="default",
    tumbleweed="default",
    twiggytrees_regrowth="default",
    walrus="default",
    walrus_setting="default",
    wanderingtrader_enabled="always",
    wasps="default",
    weather="default",
    wildfires="default",
    winter="default",
    winterhounds="default",
    winters_feast="default",
    wobsters="default",
    world_size="default",
    wormhole_prefab="wormhole",
    year_of_the_beefalo="default",
    year_of_the_bunnyman="default",
    year_of_the_carrat="default",
    year_of_the_catcoon="default",
    year_of_the_dragonfly="default",
    year_of_the_gobbler="default",
    year_of_the_knight="default",
    year_of_the_pig="default",
    year_of_the_snake="default",
    year_of_the_varg="default" 
  },
  playstyle="endless",
  random_set_pieces={
    "Sculptures_2",
    "Sculptures_3",
    "Sculptures_4",
    "Sculptures_5",
    "Chessy_1",
    "Chessy_2",
    "Chessy_3",
    "Chessy_4",
    "Chessy_5",
    "Chessy_6",
    "Maxwell1",
    "Maxwell2",
    "Maxwell3",
    "Maxwell4",
    "Maxwell6",
    "Maxwell7",
    "Warzone_1",
    "Warzone_2",
    "Warzone_3" 
  },
  required_prefabs={ "multiplayer_portal" },
  required_setpieces={ "Sculptures_1", "Maxwell5" },
  settings_desc="永不结束的饥荒沙盒模式。\\
永远可以在绚丽之门复活。",
  settings_id="ENDLESS",
  settings_name="无尽",
  substitutes={  },
  version=4,
  worldgen_desc="永不结束的饥荒沙盒模式。\\
永远可以在绚丽之门复活。",
  worldgen_id="ENDLESS",
  worldgen_name="无尽" 
}`,
  caves: `return {
  background_node_range={ 0, 1 },
  desc="探查洞穴…… 一起！",
  hideminimap=false,
  id="DST_CAVE",
  location="cave",
  max_playlist_position=999,
  min_playlist_position=0,
  name="洞穴",
  numrandom_set_pieces=0,
  override_level_string=false,
  overrides={
    acidrain_enabled="always",
    atriumgate="default",
    banana="default",
    basicresource_regrowth="always",
    bats="default",
    bats_setting="default",
    beefaloheat="default",
    berrybush="default",
    boons="default",
    branching="default",
    brightmarecreatures="default",
    bunnymen="default",
    bunnymen_setting="default",
    cave_ponds="default",
    cave_spiders="default",
    cavelight="default",
    chess="default",
    chest_mimics="default",
    crow_carnival="default",
    darkness="default",
    day="default",
    daywalker="default",
    dropeverythingondespawn="default",
    dustmoths="default",
    earthquakes="default",
    evergreen_regrowth="default",
    extrastartingitems="default",
    fern="default",
    fissure="default",
    flint="default",
    flower_cave="default",
    flower_cave_regrowth="default",
    fruitfly="default",
    ghostenabled="always",
    ghostsanitydrain="none",
    grass="default",
    grassgekkos="default",
    hallowed_nights="default",
    healthpenalty="always",
    hunger="default",
    itemmimics="default",
    krampus="default",
    layout_mode="RestrictNodesByKey",
    lessdamagetaken="none",
    lichen="default",
    liefs="default",
    lightflier_flower_regrowth="default",
    lightfliers="default",
    loop="default",
    marshbush="default",
    merms="default",
    molebats="default",
    moles_setting="default",
    monkey="default",
    monkey_setting="default",
    moon_spider="default",
    mushgnome="default",
    mushroom="default",
    mushtree="default",
    mushtree_moon_regrowth="default",
    mushtree_regrowth="default",
    mutated_birds="default",
    mutated_merm="default",
    mutated_spiderqueen="default",
    nightmarecreatures="default",
    pigs_setting="default",
    portalresurection="always",
    prefabswaps_start="default",
    reeds="default",
    reeds_regrowth="default",
    regrowth="default",
    resettime="none",
    rifts_enabled_cave="default",
    rifts_frequency_cave="default",
    roads="never",
    rock="default",
    rocky="default",
    rocky_setting="default",
    sapling="default",
    season_start="default",
    seasonalstartingitems="default",
    shadowcreatures="default",
    slurper="default",
    slurtles="default",
    slurtles_setting="default",
    snurtles="default",
    spawnmode="fixed",
    spawnprotection="default",
    specialevent="default",
    spider_dropper="default",
    spider_hider="default",
    spider_spitter="default",
    spider_warriors="default",
    spiderqueen="default",
    spiders="default",
    spiders_setting="default",
    start_location="caves",
    task_set="cave_default",
    temperaturedamage="default",
    tentacles="default",
    toadstool="default",
    touchstone="default",
    tree_rock="default",
    tree_rock_regrowth="default",
    trees="default",
    twiggytrees_regrowth="default",
    weather="default",
    winters_feast="default",
    world_size="default",
    wormattacks="default",
    wormattacks_boss="default",
    wormhole_prefab="tentacle_pillar",
    wormlights="default",
    worms="default",
    year_of_the_beefalo="default",
    year_of_the_bunnyman="default",
    year_of_the_carrat="default",
    year_of_the_catcoon="default",
    year_of_the_dragonfly="default",
    year_of_the_gobbler="default",
    year_of_the_knight="default",
    year_of_the_pig="default",
    year_of_the_snake="default",
    year_of_the_varg="default" 
  },
  required_prefabs={ "multiplayer_portal" },
  settings_desc="探查洞穴…… 一起！",
  settings_id="DST_CAVE",
  settings_name="洞穴",
  substitutes={  },
  version=4,
  worldgen_desc="探查洞穴…… 一起！",
  worldgen_id="DST_CAVE",
  worldgen_name="洞穴" 
}`,
}

// survival
const survival = {
  master: `return {
  desc="标准《饥荒》体验。",
  hideminimap=false,
  id="SURVIVAL_TOGETHER",
  location="forest",
  max_playlist_position=999,
  min_playlist_position=0,
  name="生存",
  numrandom_set_pieces=4,
  override_level_string=false,
  overrides={
    alternatehunt="default",
    angrybees="default",
    antliontribute="default",
    autumn="default",
    balatro="default",
    bananabush_portalrate="default",
    basicresource_regrowth="none",
    bats_setting="default",
    bearger="default",
    beefalo="default",
    beefaloheat="default",
    beequeen="default",
    bees="default",
    bees_setting="default",
    berrybush="default",
    birds="default",
    boons="default",
    branching="default",
    brightmarecreatures="default",
    bunnymen_setting="default",
    butterfly="default",
    buzzard="default",
    cactus="default",
    cactus_regrowth="default",
    carrot="default",
    carrots_regrowth="default",
    catcoon="default",
    catcoons="default",
    chess="default",
    cookiecutters="default",
    crabking="default",
    crow_carnival="default",
    darkness="default",
    day="default",
    daywalker2="default",
    deciduousmonster="default",
    deciduoustree_regrowth="default",
    deerclops="default",
    dragonfly="default",
    dropeverythingondespawn="default",
    evergreen_regrowth="default",
    extrastartingitems="default",
    eyeofterror="default",
    fishschools="default",
    flint="default",
    flowers="default",
    flowers_regrowth="default",
    frograin="default",
    frogs="default",
    fruitfly="default",
    ghostenabled="always",
    ghostsanitydrain="always",
    gnarwail="default",
    goosemoose="default",
    grass="default",
    grassgekkos="default",
    hallowed_nights="default",
    has_ocean=true,
    healthpenalty="always",
    hound_mounds="default",
    houndmound="default",
    hounds="default",
    hunger="default",
    hunt="default",
    junkyard="default",
    keep_disconnected_tiles=true,
    klaus="default",
    krampus="default",
    layout_mode="LinkNodesByKeys",
    lessdamagetaken="none",
    liefs="default",
    lightcrab_portalrate="default",
    lightning="default",
    lightninggoat="default",
    loop="default",
    lunarhail_frequency="default",
    lureplants="default",
    malbatross="default",
    marshbush="default",
    merm="default",
    merms="default",
    meteorshowers="default",
    meteorspawner="default",
    moles="default",
    moles_setting="default",
    monkeytail_portalrate="default",
    moon_berrybush="default",
    moon_bullkelp="default",
    moon_carrot="default",
    moon_fissure="default",
    moon_fruitdragon="default",
    moon_hotspring="default",
    moon_rock="default",
    moon_sapling="default",
    moon_spider="default",
    moon_spiders="default",
    moon_starfish="default",
    moon_tree="default",
    moon_tree_regrowth="default",
    mosquitos="default",
    mushroom="default",
    mutated_bearger="default",
    mutated_bird_gestalt="default",
    mutated_birds="default",
    mutated_buzzard_gestalt="default",
    mutated_deerclops="default",
    mutated_hounds="default",
    mutated_merm="default",
    mutated_spiderqueen="default",
    mutated_warg="default",
    no_joining_islands=true,
    no_wormholes_to_disconnected_tiles=true,
    ocean_bullkelp="default",
    ocean_otterdens="default",
    ocean_seastack="ocean_default",
    ocean_shoal="default",
    ocean_waterplant="ocean_default",
    ocean_wobsterden="default",
    otters_setting="default",
    palmcone_seed_portalrate="default",
    palmconetree="default",
    palmconetree_regrowth="default",
    penguins="default",
    penguins_moon="default",
    perd="default",
    petrification="default",
    pigs="default",
    pigs_setting="default",
    pirateraids="default",
    ponds="default",
    portal_spawnrate="default",
    portalresurection="none",
    powder_monkey_portalrate="default",
    prefabswaps_start="default",
    rabbits="default",
    rabbits_setting="default",
    reeds="default",
    reeds_regrowth="default",
    regrowth="default",
    resettime="default",
    rifts_enabled="default",
    rifts_frequency="default",
    roads="default",
    rock="default",
    rock_ice="default",
    saltstack_regrowth="default",
    sapling="default",
    season_start="default",
    seasonalstartingitems="default",
    shadowcreatures="default",
    sharkboi="default",
    sharks="default",
    spawnmode="fixed",
    spawnprotection="default",
    specialevent="default",
    spider_warriors="default",
    spiderqueen="default",
    spiders="default",
    spiders_setting="default",
    spring="default",
    squid="default",
    stageplays="default",
    start_location="default",
    summer="default",
    summerhounds="default",
    tallbirds="default",
    task_set="default",
    temperaturedamage="default",
    tentacles="default",
    terrariumchest="default",
    touchstone="default",
    trees="default",
    tumbleweed="default",
    twiggytrees_regrowth="default",
    walrus="default",
    walrus_setting="default",
    wanderingtrader_enabled="always",
    wasps="default",
    weather="default",
    wildfires="default",
    winter="default",
    winterhounds="default",
    winters_feast="default",
    wobsters="default",
    world_size="default",
    wormhole_prefab="wormhole",
    year_of_the_beefalo="default",
    year_of_the_bunnyman="default",
    year_of_the_carrat="default",
    year_of_the_catcoon="default",
    year_of_the_dragonfly="default",
    year_of_the_gobbler="default",
    year_of_the_knight="default",
    year_of_the_pig="default",
    year_of_the_snake="default",
    year_of_the_varg="default" 
  },
  playstyle="survival",
  random_set_pieces={
    "Sculptures_2",
    "Sculptures_3",
    "Sculptures_4",
    "Sculptures_5",
    "Chessy_1",
    "Chessy_2",
    "Chessy_3",
    "Chessy_4",
    "Chessy_5",
    "Chessy_6",
    "Maxwell1",
    "Maxwell2",
    "Maxwell3",
    "Maxwell4",
    "Maxwell6",
    "Maxwell7",
    "Warzone_1",
    "Warzone_2",
    "Warzone_3" 
  },
  required_prefabs={ "multiplayer_portal" },
  required_setpieces={ "Sculptures_1", "Maxwell5" },
  settings_desc="标准《饥荒》体验。",
  settings_id="SURVIVAL_TOGETHER",
  settings_name="生存",
  substitutes={  },
  version=4,
  worldgen_desc="标准《饥荒》体验。",
  worldgen_id="SURVIVAL_TOGETHER",
  worldgen_name="生存" 
}`,
  caves: `return {
  background_node_range={ 0, 1 },
  desc="探查洞穴…… 一起！",
  hideminimap=false,
  id="DST_CAVE",
  location="cave",
  max_playlist_position=999,
  min_playlist_position=0,
  name="洞穴",
  numrandom_set_pieces=0,
  override_level_string=false,
  overrides={
    acidrain_enabled="always",
    atriumgate="default",
    banana="default",
    basicresource_regrowth="none",
    bats="default",
    bats_setting="default",
    beefaloheat="default",
    berrybush="default",
    boons="default",
    branching="default",
    brightmarecreatures="default",
    bunnymen="default",
    bunnymen_setting="default",
    cave_ponds="default",
    cave_spiders="default",
    cavelight="default",
    chess="default",
    chest_mimics="default",
    crow_carnival="default",
    darkness="default",
    day="default",
    daywalker="default",
    dropeverythingondespawn="default",
    dustmoths="default",
    earthquakes="default",
    evergreen_regrowth="default",
    extrastartingitems="default",
    fern="default",
    fissure="default",
    flint="default",
    flower_cave="default",
    flower_cave_regrowth="default",
    fruitfly="default",
    ghostenabled="always",
    ghostsanitydrain="always",
    grass="default",
    grassgekkos="default",
    hallowed_nights="default",
    healthpenalty="always",
    hunger="default",
    itemmimics="default",
    krampus="default",
    layout_mode="RestrictNodesByKey",
    lessdamagetaken="none",
    lichen="default",
    liefs="default",
    lightflier_flower_regrowth="default",
    lightfliers="default",
    loop="default",
    marshbush="default",
    merms="default",
    molebats="default",
    moles_setting="default",
    monkey="default",
    monkey_setting="default",
    moon_spider="default",
    mushgnome="default",
    mushroom="default",
    mushtree="default",
    mushtree_moon_regrowth="default",
    mushtree_regrowth="default",
    mutated_birds="default",
    mutated_merm="default",
    mutated_spiderqueen="default",
    nightmarecreatures="default",
    pigs_setting="default",
    portalresurection="none",
    prefabswaps_start="default",
    reeds="default",
    reeds_regrowth="default",
    regrowth="default",
    resettime="default",
    rifts_enabled_cave="default",
    rifts_frequency_cave="default",
    roads="never",
    rock="default",
    rocky="default",
    rocky_setting="default",
    sapling="default",
    season_start="default",
    seasonalstartingitems="default",
    shadowcreatures="default",
    slurper="default",
    slurtles="default",
    slurtles_setting="default",
    snurtles="default",
    spawnmode="fixed",
    spawnprotection="default",
    specialevent="default",
    spider_dropper="default",
    spider_hider="default",
    spider_spitter="default",
    spider_warriors="default",
    spiderqueen="default",
    spiders="default",
    spiders_setting="default",
    start_location="caves",
    task_set="cave_default",
    temperaturedamage="default",
    tentacles="default",
    toadstool="default",
    touchstone="default",
    tree_rock="default",
    tree_rock_regrowth="default",
    trees="default",
    twiggytrees_regrowth="default",
    weather="default",
    winters_feast="default",
    world_size="default",
    wormattacks="default",
    wormattacks_boss="default",
    wormhole_prefab="tentacle_pillar",
    wormlights="default",
    worms="default",
    year_of_the_beefalo="default",
    year_of_the_bunnyman="default",
    year_of_the_carrat="default",
    year_of_the_catcoon="default",
    year_of_the_dragonfly="default",
    year_of_the_gobbler="default",
    year_of_the_knight="default",
    year_of_the_pig="default",
    year_of_the_snake="default",
    year_of_the_varg="default" 
  },
  required_prefabs={ "multiplayer_portal" },
  settings_desc="探查洞穴…… 一起！",
  settings_id="DST_CAVE",
  settings_name="洞穴",
  substitutes={  },
  version=4,
  worldgen_desc="探查洞穴…… 一起！",
  worldgen_id="DST_CAVE",
  worldgen_name="洞穴" 
}`,
}

// survival
const relaxed = {
  master: `return {
  desc="更轻松的游戏方式，更少受到来自世界的威胁。\\
饥饿、寒冷、过热和黑暗将不会杀死冒险家。\\
降低冒险家受到的伤害。永远可以在绚丽之门复活。",
  hideminimap=false,
  id="RELAXED",
  location="forest",
  max_playlist_position=999,
  min_playlist_position=0,
  name="轻松",
  numrandom_set_pieces=4,
  override_level_string=false,
  overrides={
    alternatehunt="default",
    angrybees="default",
    antliontribute="default",
    autumn="default",
    balatro="default",
    bananabush_portalrate="default",
    basicresource_regrowth="none",
    bats_setting="default",
    bearger="default",
    beefalo="default",
    beefaloheat="default",
    beequeen="default",
    bees="default",
    bees_setting="default",
    berrybush="default",
    birds="default",
    boons="default",
    branching="default",
    brightmarecreatures="rare",
    bunnymen_setting="default",
    butterfly="default",
    buzzard="default",
    cactus="default",
    cactus_regrowth="default",
    carrot="default",
    carrots_regrowth="default",
    catcoon="default",
    catcoons="default",
    chess="default",
    cookiecutters="default",
    crabking="default",
    crow_carnival="default",
    darkness="nonlethal",
    day="default",
    daywalker2="default",
    deciduousmonster="default",
    deciduoustree_regrowth="default",
    deerclops="default",
    dragonfly="default",
    dropeverythingondespawn="default",
    evergreen_regrowth="default",
    extrastartingitems="default",
    eyeofterror="default",
    fishschools="default",
    flint="default",
    flowers="default",
    flowers_regrowth="default",
    frograin="default",
    frogs="default",
    fruitfly="default",
    ghostenabled="always",
    ghostsanitydrain="none",
    gnarwail="default",
    goosemoose="default",
    grass="default",
    grassgekkos="default",
    hallowed_nights="default",
    has_ocean=true,
    healthpenalty="none",
    hound_mounds="default",
    houndmound="default",
    hounds="rare",
    hunger="nonlethal",
    hunt="default",
    junkyard="default",
    keep_disconnected_tiles=true,
    klaus="default",
    krampus="default",
    layout_mode="LinkNodesByKeys",
    lessdamagetaken="always",
    liefs="default",
    lightcrab_portalrate="default",
    lightning="default",
    lightninggoat="default",
    loop="default",
    lunarhail_frequency="default",
    lureplants="default",
    malbatross="default",
    marshbush="default",
    merm="default",
    merms="default",
    meteorshowers="default",
    meteorspawner="default",
    moles="default",
    moles_setting="default",
    monkeytail_portalrate="default",
    moon_berrybush="default",
    moon_bullkelp="default",
    moon_carrot="default",
    moon_fissure="default",
    moon_fruitdragon="default",
    moon_hotspring="default",
    moon_rock="default",
    moon_sapling="default",
    moon_spider="default",
    moon_spiders="default",
    moon_starfish="default",
    moon_tree="default",
    moon_tree_regrowth="default",
    mosquitos="default",
    mushroom="default",
    mutated_bearger="default",
    mutated_bird_gestalt="default",
    mutated_birds="default",
    mutated_buzzard_gestalt="default",
    mutated_deerclops="default",
    mutated_hounds="default",
    mutated_merm="default",
    mutated_spiderqueen="default",
    mutated_warg="default",
    no_joining_islands=true,
    no_wormholes_to_disconnected_tiles=true,
    ocean_bullkelp="default",
    ocean_otterdens="default",
    ocean_seastack="ocean_default",
    ocean_shoal="default",
    ocean_waterplant="ocean_default",
    ocean_wobsterden="default",
    otters_setting="default",
    palmcone_seed_portalrate="default",
    palmconetree="default",
    palmconetree_regrowth="default",
    penguins="default",
    penguins_moon="default",
    perd="default",
    petrification="default",
    pigs="default",
    pigs_setting="default",
    pirateraids="default",
    ponds="default",
    portal_spawnrate="default",
    portalresurection="always",
    powder_monkey_portalrate="default",
    prefabswaps_start="default",
    rabbits="default",
    rabbits_setting="default",
    reeds="default",
    reeds_regrowth="default",
    regrowth="default",
    resettime="none",
    rifts_enabled="default",
    rifts_frequency="default",
    roads="default",
    rock="default",
    rock_ice="default",
    saltstack_regrowth="default",
    sapling="default",
    season_start="default",
    seasonalstartingitems="default",
    shadowcreatures="rare",
    sharkboi="default",
    sharks="default",
    spawnmode="fixed",
    spawnprotection="default",
    specialevent="default",
    spider_warriors="default",
    spiderqueen="default",
    spiders="default",
    spiders_setting="default",
    spring="default",
    squid="default",
    stageplays="default",
    start_location="default",
    summer="default",
    summerhounds="default",
    tallbirds="default",
    task_set="default",
    temperaturedamage="nonlethal",
    tentacles="default",
    terrariumchest="default",
    touchstone="default",
    trees="default",
    tumbleweed="default",
    twiggytrees_regrowth="default",
    walrus="default",
    walrus_setting="default",
    wanderingtrader_enabled="always",
    wasps="default",
    weather="default",
    wildfires="never",
    winter="default",
    winterhounds="default",
    winters_feast="default",
    wobsters="default",
    world_size="default",
    wormhole_prefab="wormhole",
    year_of_the_beefalo="default",
    year_of_the_bunnyman="default",
    year_of_the_carrat="default",
    year_of_the_catcoon="default",
    year_of_the_dragonfly="default",
    year_of_the_gobbler="default",
    year_of_the_knight="default",
    year_of_the_pig="default",
    year_of_the_snake="default",
    year_of_the_varg="default" 
  },
  playstyle="relaxed",
  random_set_pieces={
    "Sculptures_2",
    "Sculptures_3",
    "Sculptures_4",
    "Sculptures_5",
    "Chessy_1",
    "Chessy_2",
    "Chessy_3",
    "Chessy_4",
    "Chessy_5",
    "Chessy_6",
    "Maxwell1",
    "Maxwell2",
    "Maxwell3",
    "Maxwell4",
    "Maxwell6",
    "Maxwell7",
    "Warzone_1",
    "Warzone_2",
    "Warzone_3" 
  },
  required_prefabs={ "multiplayer_portal" },
  required_setpieces={ "Sculptures_1", "Maxwell5" },
  settings_desc="更轻松的游戏方式，更少受到来自世界的威胁。\\
饥饿、寒冷、过热和黑暗将不会杀死冒险家。\\
降低冒险家受到的伤害。永远可以在绚丽之门复活。",
  settings_id="RELAXED",
  settings_name="轻松",
  substitutes={  },
  version=4,
  worldgen_desc="更轻松的游戏方式，更少受到来自世界的威胁。\\
饥饿、寒冷、过热和黑暗将不会杀死冒险家。\\
降低冒险家受到的伤害。永远可以在绚丽之门复活。",
  worldgen_id="RELAXED",
  worldgen_name="轻松" 
}`,
  caves: `return {
  background_node_range={ 0, 1 },
  desc="探查洞穴…… 一起！",
  hideminimap=false,
  id="DST_CAVE",
  location="cave",
  max_playlist_position=999,
  min_playlist_position=0,
  name="洞穴",
  numrandom_set_pieces=0,
  override_level_string=false,
  overrides={
    acidrain_enabled="always",
    atriumgate="default",
    banana="default",
    basicresource_regrowth="none",
    bats="default",
    bats_setting="default",
    beefaloheat="default",
    berrybush="default",
    boons="default",
    branching="default",
    brightmarecreatures="rare",
    bunnymen="default",
    bunnymen_setting="default",
    cave_ponds="default",
    cave_spiders="default",
    cavelight="default",
    chess="default",
    chest_mimics="default",
    crow_carnival="default",
    darkness="nonlethal",
    day="default",
    daywalker="default",
    dropeverythingondespawn="default",
    dustmoths="default",
    earthquakes="default",
    evergreen_regrowth="default",
    extrastartingitems="default",
    fern="default",
    fissure="default",
    flint="default",
    flower_cave="default",
    flower_cave_regrowth="default",
    fruitfly="default",
    ghostenabled="always",
    ghostsanitydrain="none",
    grass="default",
    grassgekkos="default",
    hallowed_nights="default",
    healthpenalty="none",
    hunger="nonlethal",
    itemmimics="default",
    krampus="default",
    layout_mode="RestrictNodesByKey",
    lessdamagetaken="always",
    lichen="default",
    liefs="default",
    lightflier_flower_regrowth="default",
    lightfliers="default",
    loop="default",
    marshbush="default",
    merms="default",
    molebats="default",
    moles_setting="default",
    monkey="default",
    monkey_setting="default",
    moon_spider="default",
    mushgnome="default",
    mushroom="default",
    mushtree="default",
    mushtree_moon_regrowth="default",
    mushtree_regrowth="default",
    mutated_birds="default",
    mutated_merm="default",
    mutated_spiderqueen="default",
    nightmarecreatures="default",
    pigs_setting="default",
    portalresurection="always",
    prefabswaps_start="default",
    reeds="default",
    reeds_regrowth="default",
    regrowth="default",
    resettime="none",
    rifts_enabled_cave="default",
    rifts_frequency_cave="default",
    roads="never",
    rock="default",
    rocky="default",
    rocky_setting="default",
    sapling="default",
    season_start="default",
    seasonalstartingitems="default",
    shadowcreatures="rare",
    slurper="default",
    slurtles="default",
    slurtles_setting="default",
    snurtles="default",
    spawnmode="fixed",
    spawnprotection="default",
    specialevent="default",
    spider_dropper="default",
    spider_hider="default",
    spider_spitter="default",
    spider_warriors="default",
    spiderqueen="default",
    spiders="default",
    spiders_setting="default",
    start_location="caves",
    task_set="cave_default",
    temperaturedamage="nonlethal",
    tentacles="default",
    toadstool="default",
    touchstone="default",
    tree_rock="default",
    tree_rock_regrowth="default",
    trees="default",
    twiggytrees_regrowth="default",
    weather="default",
    winters_feast="default",
    world_size="default",
    wormattacks="default",
    wormattacks_boss="default",
    wormhole_prefab="tentacle_pillar",
    wormlights="default",
    worms="default",
    year_of_the_beefalo="default",
    year_of_the_bunnyman="default",
    year_of_the_carrat="default",
    year_of_the_catcoon="default",
    year_of_the_dragonfly="default",
    year_of_the_gobbler="default",
    year_of_the_knight="default",
    year_of_the_pig="default",
    year_of_the_snake="default",
    year_of_the_varg="default" 
  },
  required_prefabs={ "multiplayer_portal" },
  settings_desc="探查洞穴…… 一起！",
  settings_id="DST_CAVE",
  settings_name="洞穴",
  substitutes={  },
  version=4,
  worldgen_desc="探查洞穴…… 一起！",
  worldgen_id="DST_CAVE",
  worldgen_name="洞穴" 
}`,
}

// survival
const wilderness = {
  master: `return {
  desc="外面就是荒野，充满了危险！\\
随机进入世界的一个地方。\\
死亡之后：选一名新冒险家试一下、再试一下。",
  hideminimap=false,
  id="WILDERNESS",
  location="forest",
  max_playlist_position=999,
  min_playlist_position=0,
  name="荒野",
  numrandom_set_pieces=4,
  override_level_string=false,
  overrides={
    alternatehunt="default",
    angrybees="default",
    antliontribute="default",
    autumn="default",
    balatro="default",
    bananabush_portalrate="default",
    basicresource_regrowth="always",
    bats_setting="default",
    bearger="default",
    beefalo="default",
    beefaloheat="default",
    beequeen="default",
    bees="default",
    bees_setting="default",
    berrybush="default",
    birds="default",
    boons="default",
    branching="default",
    brightmarecreatures="default",
    bunnymen_setting="default",
    butterfly="default",
    buzzard="default",
    cactus="default",
    cactus_regrowth="default",
    carrot="default",
    carrots_regrowth="default",
    catcoon="default",
    catcoons="default",
    chess="default",
    cookiecutters="default",
    crabking="default",
    crow_carnival="default",
    darkness="default",
    day="default",
    daywalker2="default",
    deciduousmonster="default",
    deciduoustree_regrowth="default",
    deerclops="default",
    dragonfly="default",
    dropeverythingondespawn="default",
    evergreen_regrowth="default",
    extrastartingitems="default",
    eyeofterror="default",
    fishschools="default",
    flint="default",
    flowers="default",
    flowers_regrowth="default",
    frograin="default",
    frogs="default",
    fruitfly="default",
    ghostenabled="none",
    ghostsanitydrain="none",
    gnarwail="default",
    goosemoose="default",
    grass="default",
    grassgekkos="default",
    hallowed_nights="default",
    has_ocean=true,
    healthpenalty="always",
    hound_mounds="default",
    houndmound="default",
    hounds="default",
    hunger="default",
    hunt="default",
    junkyard="default",
    keep_disconnected_tiles=true,
    klaus="default",
    krampus="default",
    layout_mode="LinkNodesByKeys",
    lessdamagetaken="none",
    liefs="default",
    lightcrab_portalrate="default",
    lightning="default",
    lightninggoat="default",
    loop="default",
    lunarhail_frequency="default",
    lureplants="default",
    malbatross="default",
    marshbush="default",
    merm="default",
    merms="default",
    meteorshowers="default",
    meteorspawner="default",
    moles="default",
    moles_setting="default",
    monkeytail_portalrate="default",
    moon_berrybush="default",
    moon_bullkelp="default",
    moon_carrot="default",
    moon_fissure="default",
    moon_fruitdragon="default",
    moon_hotspring="default",
    moon_rock="default",
    moon_sapling="default",
    moon_spider="default",
    moon_spiders="default",
    moon_starfish="default",
    moon_tree="default",
    moon_tree_regrowth="default",
    mosquitos="default",
    mushroom="default",
    mutated_bearger="default",
    mutated_bird_gestalt="default",
    mutated_birds="default",
    mutated_buzzard_gestalt="default",
    mutated_deerclops="default",
    mutated_hounds="default",
    mutated_merm="default",
    mutated_spiderqueen="default",
    mutated_warg="default",
    no_joining_islands=true,
    no_wormholes_to_disconnected_tiles=true,
    ocean_bullkelp="default",
    ocean_otterdens="default",
    ocean_seastack="ocean_default",
    ocean_shoal="default",
    ocean_waterplant="ocean_default",
    ocean_wobsterden="default",
    otters_setting="default",
    palmcone_seed_portalrate="default",
    palmconetree="default",
    palmconetree_regrowth="default",
    penguins="default",
    penguins_moon="default",
    perd="default",
    petrification="default",
    pigs="default",
    pigs_setting="default",
    pirateraids="default",
    ponds="default",
    portal_spawnrate="default",
    portalresurection="none",
    powder_monkey_portalrate="default",
    prefabswaps_start="default",
    rabbits="default",
    rabbits_setting="default",
    reeds="default",
    reeds_regrowth="default",
    regrowth="default",
    resettime="none",
    rifts_enabled="default",
    rifts_frequency="default",
    roads="default",
    rock="default",
    rock_ice="default",
    saltstack_regrowth="default",
    sapling="default",
    season_start="default",
    seasonalstartingitems="default",
    shadowcreatures="default",
    sharkboi="default",
    sharks="default",
    spawnmode="scatter",
    spawnprotection="default",
    specialevent="default",
    spider_warriors="default",
    spiderqueen="default",
    spiders="default",
    spiders_setting="default",
    spring="default",
    squid="default",
    stageplays="default",
    start_location="default",
    summer="default",
    summerhounds="default",
    tallbirds="default",
    task_set="default",
    temperaturedamage="default",
    tentacles="default",
    terrariumchest="default",
    touchstone="default",
    trees="default",
    tumbleweed="default",
    twiggytrees_regrowth="default",
    walrus="default",
    walrus_setting="default",
    wanderingtrader_enabled="always",
    wasps="default",
    weather="default",
    wildfires="default",
    winter="default",
    winterhounds="default",
    winters_feast="default",
    wobsters="default",
    world_size="default",
    wormhole_prefab="wormhole",
    year_of_the_beefalo="default",
    year_of_the_bunnyman="default",
    year_of_the_carrat="default",
    year_of_the_catcoon="default",
    year_of_the_dragonfly="default",
    year_of_the_gobbler="default",
    year_of_the_knight="default",
    year_of_the_pig="default",
    year_of_the_snake="default",
    year_of_the_varg="default" 
  },
  playstyle="wilderness",
  random_set_pieces={
    "Sculptures_2",
    "Sculptures_3",
    "Sculptures_4",
    "Sculptures_5",
    "Chessy_1",
    "Chessy_2",
    "Chessy_3",
    "Chessy_4",
    "Chessy_5",
    "Chessy_6",
    "Maxwell1",
    "Maxwell2",
    "Maxwell3",
    "Maxwell4",
    "Maxwell6",
    "Maxwell7",
    "Warzone_1",
    "Warzone_2",
    "Warzone_3" 
  },
  required_prefabs={ "multiplayer_portal" },
  required_setpieces={ "Sculptures_1", "Maxwell5" },
  settings_desc="外面就是荒野，充满了危险！\\
随机进入世界的一个地方。\\
死亡之后：选一名新冒险家试一下、再试一下。",
  settings_id="WILDERNESS",
  settings_name="荒野",
  substitutes={  },
  version=4,
  worldgen_desc="外面就是荒野，充满了危险！\\
随机进入世界的一个地方。\\
死亡之后：选一名新冒险家试一下、再试一下。",
  worldgen_id="WILDERNESS",
  worldgen_name="荒野" 
}`,
  caves: `return {
  background_node_range={ 0, 1 },
  desc="探查洞穴…… 一起！",
  hideminimap=false,
  id="DST_CAVE",
  location="cave",
  max_playlist_position=999,
  min_playlist_position=0,
  name="洞穴",
  numrandom_set_pieces=0,
  override_level_string=false,
  overrides={
    acidrain_enabled="always",
    atriumgate="default",
    banana="default",
    basicresource_regrowth="always",
    bats="default",
    bats_setting="default",
    beefaloheat="default",
    berrybush="default",
    boons="default",
    branching="default",
    brightmarecreatures="default",
    bunnymen="default",
    bunnymen_setting="default",
    cave_ponds="default",
    cave_spiders="default",
    cavelight="default",
    chess="default",
    chest_mimics="default",
    crow_carnival="default",
    darkness="default",
    day="default",
    daywalker="default",
    dropeverythingondespawn="default",
    dustmoths="default",
    earthquakes="default",
    evergreen_regrowth="default",
    extrastartingitems="default",
    fern="default",
    fissure="default",
    flint="default",
    flower_cave="default",
    flower_cave_regrowth="default",
    fruitfly="default",
    ghostenabled="none",
    ghostsanitydrain="none",
    grass="default",
    grassgekkos="default",
    hallowed_nights="default",
    healthpenalty="always",
    hunger="default",
    itemmimics="default",
    krampus="default",
    layout_mode="RestrictNodesByKey",
    lessdamagetaken="none",
    lichen="default",
    liefs="default",
    lightflier_flower_regrowth="default",
    lightfliers="default",
    loop="default",
    marshbush="default",
    merms="default",
    molebats="default",
    moles_setting="default",
    monkey="default",
    monkey_setting="default",
    moon_spider="default",
    mushgnome="default",
    mushroom="default",
    mushtree="default",
    mushtree_moon_regrowth="default",
    mushtree_regrowth="default",
    mutated_birds="default",
    mutated_merm="default",
    mutated_spiderqueen="default",
    nightmarecreatures="default",
    pigs_setting="default",
    portalresurection="none",
    prefabswaps_start="default",
    reeds="default",
    reeds_regrowth="default",
    regrowth="default",
    resettime="none",
    rifts_enabled_cave="default",
    rifts_frequency_cave="default",
    roads="never",
    rock="default",
    rocky="default",
    rocky_setting="default",
    sapling="default",
    season_start="default",
    seasonalstartingitems="default",
    shadowcreatures="default",
    slurper="default",
    slurtles="default",
    slurtles_setting="default",
    snurtles="default",
    spawnmode="scatter",
    spawnprotection="default",
    specialevent="default",
    spider_dropper="default",
    spider_hider="default",
    spider_spitter="default",
    spider_warriors="default",
    spiderqueen="default",
    spiders="default",
    spiders_setting="default",
    start_location="caves",
    task_set="cave_default",
    temperaturedamage="default",
    tentacles="default",
    toadstool="default",
    touchstone="default",
    tree_rock="default",
    tree_rock_regrowth="default",
    trees="default",
    twiggytrees_regrowth="default",
    weather="default",
    winters_feast="default",
    world_size="default",
    wormattacks="default",
    wormattacks_boss="default",
    wormhole_prefab="tentacle_pillar",
    wormlights="default",
    worms="default",
    year_of_the_beefalo="default",
    year_of_the_bunnyman="default",
    year_of_the_carrat="default",
    year_of_the_catcoon="default",
    year_of_the_dragonfly="default",
    year_of_the_gobbler="default",
    year_of_the_knight="default",
    year_of_the_pig="default",
    year_of_the_snake="default",
    year_of_the_varg="default" 
  },
  required_prefabs={ "multiplayer_portal" },
  settings_desc="探查洞穴…… 一起！",
  settings_id="DST_CAVE",
  settings_name="洞穴",
  substitutes={  },
  version=4,
  worldgen_desc="探查洞穴…… 一起！",
  worldgen_id="DST_CAVE",
  worldgen_name="洞穴" 
}`,
}

// survival
const lightsOut = {
  master: `return {
  desc="在标准《饥荒》体验的基础上添加黑暗基调。",
  hideminimap=false,
  id="LIGHTS_OUT",
  location="forest",
  max_playlist_position=999,
  min_playlist_position=0,
  name="暗无天日",
  numrandom_set_pieces=4,
  override_level_string=false,
  overrides={
    alternatehunt="default",
    angrybees="default",
    antliontribute="default",
    autumn="default",
    balatro="default",
    bananabush_portalrate="default",
    basicresource_regrowth="none",
    bats_setting="default",
    bearger="default",
    beefalo="default",
    beefaloheat="default",
    beequeen="default",
    bees="default",
    bees_setting="default",
    berrybush="default",
    birds="default",
    boons="default",
    branching="default",
    brightmarecreatures="default",
    bunnymen_setting="default",
    butterfly="default",
    buzzard="default",
    cactus="default",
    cactus_regrowth="default",
    carrot="default",
    carrots_regrowth="default",
    catcoon="default",
    catcoons="default",
    chess="default",
    cookiecutters="default",
    crabking="default",
    crow_carnival="default",
    darkness="default",
    day="onlynight",
    daywalker2="default",
    deciduousmonster="default",
    deciduoustree_regrowth="default",
    deerclops="default",
    dragonfly="default",
    dropeverythingondespawn="default",
    evergreen_regrowth="default",
    extrastartingitems="default",
    eyeofterror="default",
    fishschools="default",
    flint="default",
    flowers="default",
    flowers_regrowth="default",
    frograin="default",
    frogs="default",
    fruitfly="default",
    ghostenabled="always",
    ghostsanitydrain="always",
    gnarwail="default",
    goosemoose="default",
    grass="default",
    grassgekkos="default",
    hallowed_nights="default",
    has_ocean=true,
    healthpenalty="always",
    hound_mounds="default",
    houndmound="default",
    hounds="default",
    hunger="default",
    hunt="default",
    junkyard="default",
    keep_disconnected_tiles=true,
    klaus="default",
    krampus="default",
    layout_mode="LinkNodesByKeys",
    lessdamagetaken="none",
    liefs="default",
    lightcrab_portalrate="default",
    lightning="default",
    lightninggoat="default",
    loop="default",
    lunarhail_frequency="default",
    lureplants="default",
    malbatross="default",
    marshbush="default",
    merm="default",
    merms="default",
    meteorshowers="default",
    meteorspawner="default",
    moles="default",
    moles_setting="default",
    monkeytail_portalrate="default",
    moon_berrybush="default",
    moon_bullkelp="default",
    moon_carrot="default",
    moon_fissure="default",
    moon_fruitdragon="default",
    moon_hotspring="default",
    moon_rock="default",
    moon_sapling="default",
    moon_spider="default",
    moon_spiders="default",
    moon_starfish="default",
    moon_tree="default",
    moon_tree_regrowth="default",
    mosquitos="default",
    mushroom="default",
    mutated_bearger="default",
    mutated_bird_gestalt="default",
    mutated_birds="default",
    mutated_buzzard_gestalt="default",
    mutated_deerclops="default",
    mutated_hounds="default",
    mutated_merm="default",
    mutated_spiderqueen="default",
    mutated_warg="default",
    no_joining_islands=true,
    no_wormholes_to_disconnected_tiles=true,
    ocean_bullkelp="default",
    ocean_otterdens="default",
    ocean_seastack="ocean_default",
    ocean_shoal="default",
    ocean_waterplant="ocean_default",
    ocean_wobsterden="default",
    otters_setting="default",
    palmcone_seed_portalrate="default",
    palmconetree="default",
    palmconetree_regrowth="default",
    penguins="default",
    penguins_moon="default",
    perd="default",
    petrification="default",
    pigs="default",
    pigs_setting="default",
    pirateraids="default",
    ponds="default",
    portal_spawnrate="default",
    portalresurection="none",
    powder_monkey_portalrate="default",
    prefabswaps_start="default",
    rabbits="default",
    rabbits_setting="default",
    reeds="default",
    reeds_regrowth="default",
    regrowth="default",
    resettime="default",
    rifts_enabled="default",
    rifts_frequency="default",
    roads="default",
    rock="default",
    rock_ice="default",
    saltstack_regrowth="default",
    sapling="default",
    season_start="default",
    seasonalstartingitems="default",
    shadowcreatures="default",
    sharkboi="default",
    sharks="default",
    spawnmode="fixed",
    spawnprotection="default",
    specialevent="default",
    spider_warriors="default",
    spiderqueen="default",
    spiders="default",
    spiders_setting="default",
    spring="default",
    squid="default",
    stageplays="default",
    start_location="darkness",
    summer="default",
    summerhounds="default",
    tallbirds="default",
    task_set="default",
    temperaturedamage="default",
    tentacles="default",
    terrariumchest="default",
    touchstone="default",
    trees="default",
    tumbleweed="default",
    twiggytrees_regrowth="default",
    walrus="default",
    walrus_setting="default",
    wanderingtrader_enabled="always",
    wasps="default",
    weather="default",
    wildfires="default",
    winter="default",
    winterhounds="default",
    winters_feast="default",
    wobsters="default",
    world_size="default",
    wormhole_prefab="wormhole",
    year_of_the_beefalo="default",
    year_of_the_bunnyman="default",
    year_of_the_carrat="default",
    year_of_the_catcoon="default",
    year_of_the_dragonfly="default",
    year_of_the_gobbler="default",
    year_of_the_knight="default",
    year_of_the_pig="default",
    year_of_the_snake="default",
    year_of_the_varg="default" 
  },
  playstyle="lightsout",
  random_set_pieces={
    "Sculptures_2",
    "Sculptures_3",
    "Sculptures_4",
    "Sculptures_5",
    "Chessy_1",
    "Chessy_2",
    "Chessy_3",
    "Chessy_4",
    "Chessy_5",
    "Chessy_6",
    "Maxwell1",
    "Maxwell2",
    "Maxwell3",
    "Maxwell4",
    "Maxwell6",
    "Maxwell7",
    "Warzone_1",
    "Warzone_2",
    "Warzone_3" 
  },
  required_prefabs={ "multiplayer_portal" },
  required_setpieces={ "Sculptures_1", "Maxwell5" },
  settings_desc="在标准《饥荒》体验的基础上添加黑暗基调。",
  settings_id="LIGHTS_OUT",
  settings_name="暗无天日",
  substitutes={  },
  version=4,
  worldgen_desc="在标准《饥荒》体验的基础上添加黑暗基调。",
  worldgen_id="LIGHTS_OUT",
  worldgen_name="暗无天日" 
}`,
  caves: `return {
  background_node_range={ 0, 1 },
  desc="探查洞穴…… 一起！",
  hideminimap=false,
  id="DST_CAVE",
  location="cave",
  max_playlist_position=999,
  min_playlist_position=0,
  name="洞穴",
  numrandom_set_pieces=0,
  override_level_string=false,
  overrides={
    acidrain_enabled="always",
    atriumgate="default",
    banana="default",
    basicresource_regrowth="none",
    bats="default",
    bats_setting="default",
    beefaloheat="default",
    berrybush="default",
    boons="default",
    branching="default",
    brightmarecreatures="default",
    bunnymen="default",
    bunnymen_setting="default",
    cave_ponds="default",
    cave_spiders="default",
    cavelight="default",
    chess="default",
    chest_mimics="default",
    crow_carnival="default",
    darkness="default",
    day="onlynight",
    daywalker="default",
    dropeverythingondespawn="default",
    dustmoths="default",
    earthquakes="default",
    evergreen_regrowth="default",
    extrastartingitems="default",
    fern="default",
    fissure="default",
    flint="default",
    flower_cave="default",
    flower_cave_regrowth="default",
    fruitfly="default",
    ghostenabled="always",
    ghostsanitydrain="always",
    grass="default",
    grassgekkos="default",
    hallowed_nights="default",
    healthpenalty="always",
    hunger="default",
    itemmimics="default",
    krampus="default",
    layout_mode="RestrictNodesByKey",
    lessdamagetaken="none",
    lichen="default",
    liefs="default",
    lightflier_flower_regrowth="default",
    lightfliers="default",
    loop="default",
    marshbush="default",
    merms="default",
    molebats="default",
    moles_setting="default",
    monkey="default",
    monkey_setting="default",
    moon_spider="default",
    mushgnome="default",
    mushroom="default",
    mushtree="default",
    mushtree_moon_regrowth="default",
    mushtree_regrowth="default",
    mutated_birds="default",
    mutated_merm="default",
    mutated_spiderqueen="default",
    nightmarecreatures="default",
    pigs_setting="default",
    portalresurection="none",
    prefabswaps_start="default",
    reeds="default",
    reeds_regrowth="default",
    regrowth="default",
    resettime="default",
    rifts_enabled_cave="default",
    rifts_frequency_cave="default",
    roads="never",
    rock="default",
    rocky="default",
    rocky_setting="default",
    sapling="default",
    season_start="default",
    seasonalstartingitems="default",
    shadowcreatures="default",
    slurper="default",
    slurtles="default",
    slurtles_setting="default",
    snurtles="default",
    spawnmode="fixed",
    spawnprotection="default",
    specialevent="default",
    spider_dropper="default",
    spider_hider="default",
    spider_spitter="default",
    spider_warriors="default",
    spiderqueen="default",
    spiders="default",
    spiders_setting="default",
    start_location="caves",
    task_set="cave_default",
    temperaturedamage="default",
    tentacles="default",
    toadstool="default",
    touchstone="default",
    tree_rock="default",
    tree_rock_regrowth="default",
    trees="default",
    twiggytrees_regrowth="default",
    weather="default",
    winters_feast="default",
    world_size="default",
    wormattacks="default",
    wormattacks_boss="default",
    wormhole_prefab="tentacle_pillar",
    wormlights="default",
    worms="default",
    year_of_the_beefalo="default",
    year_of_the_bunnyman="default",
    year_of_the_carrat="default",
    year_of_the_catcoon="default",
    year_of_the_dragonfly="default",
    year_of_the_gobbler="default",
    year_of_the_knight="default",
    year_of_the_pig="default",
    year_of_the_snake="default",
    year_of_the_varg="default" 
  },
  required_prefabs={ "multiplayer_portal" },
  settings_desc="探查洞穴…… 一起！",
  settings_id="DST_CAVE",
  settings_name="洞穴",
  substitutes={  },
  version=4,
  worldgen_desc="探查洞穴…… 一起！",
  worldgen_id="DST_CAVE",
  worldgen_name="洞穴" 
}`,
}

// lavaarena
const lavaarena = {
  master: `return {
  background_node_range={ 0, 1 },
  desc="你敢去熔炉里证明你自己的实力吗？",
  hideminimap=false,
  id="LAVAARENA",
  location="lavaarena",
  max_playlist_position=999,
  min_playlist_position=0,
  name="熔炉",
  numrandom_set_pieces=0,
  override_level_string=false,
  overrides={
    autumn="default",
    basicresource_regrowth="none",
    beefaloheat="default",
    boons="never",
    brightmarecreatures="default",
    crow_carnival="default",
    darkness="default",
    day="default",
    dropeverythingondespawn="default",
    extrastartingitems="default",
    ghostenabled="always",
    ghostsanitydrain="always",
    hallowed_nights="default",
    healthpenalty="always",
    hunger="default",
    keep_disconnected_tiles=true,
    krampus="default",
    layout_mode="RestrictNodesByKey",
    lessdamagetaken="none",
    no_joining_islands=true,
    no_wormholes_to_disconnected_tiles=true,
    poi="never",
    portalresurection="none",
    protected="never",
    resettime="default",
    roads="never",
    season_start="default",
    seasonalstartingitems="default",
    shadowcreatures="default",
    spawnmode="fixed",
    spawnprotection="default",
    specialevent="default",
    spring="default",
    start_location="lavaarena",
    summer="default",
    task_set="lavaarena_taskset",
    temperaturedamage="default",
    touchstone="never",
    traps="never",
    winter="default",
    winters_feast="default",
    world_size="small",
    year_of_the_beefalo="default",
    year_of_the_bunnyman="default",
    year_of_the_carrat="default",
    year_of_the_catcoon="default",
    year_of_the_dragonfly="default",
    year_of_the_gobbler="default",
    year_of_the_pig="default",
    year_of_the_varg="default" 
  },
  required_prefabs={ "lavaarena_portal" },
  settings_desc="你敢去熔炉里证明你自己的实力吗？",
  settings_id="LAVAARENA",
  settings_name="熔炉",
  substitutes={  },
  version=2,
  worldgen_desc="你敢去熔炉里证明你自己的实力吗？",
  worldgen_id="LAVAARENA",
  worldgen_name="熔炉" 
}`,
}

const quagmire = {
  master: `return {
  background_node_range={ 0, 1 },
  desc="你能经受暴食的挑战吗？",
  hideminimap=false,
  id="QUAGMIRE",
  location="quagmire",
  max_playlist_position=999,
  min_playlist_position=0,
  name="暴食",
  numrandom_set_pieces=0,
  override_level_string=false,
  overrides={
    autumn="default",
    basicresource_regrowth="none",
    beefaloheat="default",
    boons="never",
    branching="random",
    brightmarecreatures="default",
    crow_carnival="default",
    darkness="default",
    day="default",
    disease_delay="none",
    dropeverythingondespawn="default",
    extrastartingitems="default",
    ghostenabled="always",
    ghostsanitydrain="always",
    hallowed_nights="default",
    healthpenalty="always",
    hunger="default",
    keep_disconnected_tiles=false,
    krampus="default",
    layout_mode="RestrictNodesByKey",
    lessdamagetaken="none",
    loop_percent=0,
    no_joining_islands=true,
    no_wormholes_to_disconnected_tiles=true,
    petrification="none",
    poi="never",
    portalresurection="none",
    prefabswaps_start="classic",
    protected="never",
    resettime="default",
    roads="never",
    season_start="default",
    seasonalstartingitems="default",
    shadowcreatures="default",
    spawnmode="fixed",
    spawnprotection="default",
    specialevent="default",
    spring="default",
    start_location="quagmire_startlocation",
    summer="default",
    task_set="quagmire_taskset",
    temperaturedamage="default",
    touchstone="never",
    traps="never",
    wildfires="never",
    winter="default",
    winters_feast="default",
    world_size="small",
    year_of_the_beefalo="default",
    year_of_the_bunnyman="default",
    year_of_the_carrat="default",
    year_of_the_catcoon="default",
    year_of_the_gobbler="default",
    year_of_the_pig="default",
    year_of_the_varg="default" 
  },
  required_prefabs={ "quagmire_portal" },
  settings_desc="你能经受暴食的挑战吗？",
  settings_id="QUAGMIRE",
  settings_name="暴食",
  substitutes={  },
  version=2,
  worldgen_desc="你能经受暴食的挑战吗？",
  worldgen_id="QUAGMIRE",
  worldgen_name="暴食" 
}`,
}


const parseLevelData = levelData => luaparse.parse(levelData, { ranges: true })

const getFieldKey = field => {
  if (field.type === 'TableKeyString') {
    return field.key.name
  }

  if (field.type === 'TableKey' && field.key.type === 'StringLiteral') {
    return getStringValue(field.key)
  }

  return null
}

const getStringValue = node => {
  if (typeof node.value === 'string') {
    return node.value
  }

  const raw = node.raw || ''
  const body = raw.slice(1, -1)

  const escapes = {
    '\\': '\\',
    '"': '"',
    "'": "'",
    n: '\n',
    r: '\r',
    t: '\t',
    b: '\b',
    f: '\f',
    v: '\v',
  }

  return body.replace(/\\([\\"'nrtbfv])/g, (match, character) => escapes[character] ?? match)
}

const getOverridesTable = ast => {
  const returnStatement = ast.body.find(statement => statement.type === 'ReturnStatement')
  const returnTable = returnStatement?.arguments?.find(argument => argument.type === 'TableConstructorExpression')

  if (!returnTable) {
    return null
  }

  const overridesField = returnTable.fields.find(field => getFieldKey(field) === 'overrides')

  return overridesField?.value?.type === 'TableConstructorExpression' ? overridesField.value : null
}

const getOverrideValue = (node, levelData) => {
  if (node.type === 'StringLiteral') {
    return {
      type: 'string',
      value: getStringValue(node),
      raw: node.raw,
    }
  }

  if (node.type === 'NumericLiteral') {
    return {
      type: 'number',
      value: node.value,
      raw: node.raw,
    }
  }

  if (node.type === 'BooleanLiteral') {
    return {
      type: 'boolean',
      value: node.value,
      raw: node.raw,
    }
  }

  return {
    type: 'complex',
    value: null,
    raw: node.range ? levelData.slice(node.range[0], node.range[1]) : node.type,
  }
}

const toLuaString = value => `"${String(value)
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\r/g, '\\r')
  .replace(/\n/g, '\n')
  .replace(/\t/g, '\\t')
  .replaceAll(String.fromCharCode(8), '\\b')
  .replace(/\f/g, '\\f')
  .replace(/\v/g, '\\v')}"`

const serializeOverrideValue = (type, value) => {
  if (type === 'string') {
    return toLuaString(value)
  }

  if (type === 'number') {
    if (typeof value === 'string' && value.trim() === '') {
      throw new Error('Numeric override value cannot be empty')
    }

    const numberValue = Number(value)

    if (!Number.isFinite(numberValue)) {
      throw new Error('Invalid numeric override value')
    }

    return String(numberValue)
  }

  if (type === 'boolean') {
    return value ? 'true' : 'false'
  }

  throw new Error(`Unsupported override value type: ${type}`)
}

const readLevelDataOverrides = levelData => {
  const ast = parseLevelData(levelData)
  const overridesTable = getOverridesTable(ast)
  const values = {}
  const entries = []
  const metadata = {}
  const returned = ast.body.find(node => node.type === 'ReturnStatement')?.arguments[0]
  for (const field of returned?.fields || []) {
    const name = getFieldKey(field)
    if (['location', 'id', 'settings_name', 'worldgen_name'].includes(name) && field.value?.type === 'StringLiteral') {
      metadata[name] = getOverrideValue(field.value, levelData).value
    }
  }

  if (!overridesTable) {
    return { values, entries, metadata }
  }

  for (const field of overridesTable.fields) {
    const name = getFieldKey(field)

    if (!name || !field.value) {
      continue
    }

    const overrideValue = getOverrideValue(field.value, levelData)

    values[name] = overrideValue.type === 'string'
      ? overrideValue.value
      : String(overrideValue.value)
    entries.push({ name, ...overrideValue })
  }

  return { values, entries, metadata }
}

const replaceLevelDataOverride = (levelData, name, type, value) => {
  const ast = parseLevelData(levelData)
  const overridesTable = getOverridesTable(ast)
  const field = overridesTable?.fields.find(item => getFieldKey(item) === name)

  if (!field?.value?.range) {
    throw new Error(`Override not found: ${name}`)
  }

  const replacement = serializeOverrideValue(type, value)
  const [start, end] = field.value.range

  return `${levelData.slice(0, start)}${replacement}${levelData.slice(end)}`
}

// FeatherPanel: validate static world data without evaluating user Lua.
const validateLevelData = source => {
  if (typeof source !== 'string' || source.length > 262144) throw Error('世界代码最多支持 262144 个字符');
  let ast;
  try { ast = luaparse.parse(source, { ranges: true, luaVersion: '5.1' }); }
  catch (cause) {
    const error = Error('Lua 语法有误，请检查括号、引号和逗号');
    error.line = cause.line; error.column = (cause.column || 0) + 1; throw error;
  }
  const fail = (message, node) => {
    const error = Error(message), prefix = source.slice(0, node?.range?.[0] || 0).split('\n');
    error.line = prefix.length; error.column = prefix.at(-1).length + 1; throw error;
  };
  const statement = ast.body[0], root = statement?.arguments?.[0];
  if (ast.body.length !== 1 || statement?.type !== 'ReturnStatement' || statement.arguments.length !== 1 || root?.type !== 'TableConstructorExpression') fail('世界配置必须使用 return { ... } 返回一个静态表', statement);
  const check = (node, depth = 0) => {
    if (depth > 100) fail('世界配置嵌套过深', node);
    if (['StringLiteral', 'BooleanLiteral', 'NilLiteral'].includes(node.type)) return;
    if (node.type === 'NumericLiteral' && Number.isFinite(node.value)) return;
    if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral' && Number.isFinite(node.argument.value)) return;
    if (node.type === 'TableConstructorExpression') {
      const keys = new Set();
      for (const field of node.fields) {
        const key = getFieldKey(field);
        if (key !== null && keys.has(key)) fail('配置键重复：' + key, field);
        if (key !== null) keys.add(key);
        if (field.type === 'TableKey') check(field.key, depth + 1);
        check(field.value, depth + 1);
      }
      return;
    }
    fail('仅支持静态配置值，不能包含函数调用、变量或计算表达式', node);
  };
  check(root);
  const overridesField = root.fields.find(field => getFieldKey(field) === 'overrides');
  if (overridesField?.value?.type !== 'TableConstructorExpression') fail('世界配置需要 overrides = { ... } 配置表', overridesField || root);
  return readLevelDataOverrides(source);
};

window.FeatherDmp={presets:{endless,survival,relaxed,wilderness,lightsOut,lavaarena,quagmire},overrides,caveOverrideWorldGenerationWorld,configsMap,groundWorldRule,groundWorldGeneration,cavesWorldRule,cavesWorldGeneration,readLevelDataOverrides,replaceLevelDataOverride,validateLevelData};
})();
