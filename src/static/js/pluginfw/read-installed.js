'use strict';

// A copy of npm/lib/utils/read-installed.js
// that is hacked to not cache everything :)

// Walk through the file-system "database" of installed
// packages, and create a data object related to the
// installed versions of each package.

/*
This will traverse through all node_modules folders,
resolving the dependencies object to the object corresponding to
the package that meets that dep, or just the version/range if
unmet.

Assuming that you had this folder structure:

/path/to
+-- package.json { name = "root" }
`-- node_modules
    +-- foo {bar, baz, asdf}
    | +-- node_modules
    |   +-- bar { baz }
    |   `-- baz
    `-- asdf

where "foo" depends on bar, baz, and asdf, bar depends on baz,
and bar and baz are bundled with foo, whereas "asdf" is at
the higher level (sibling to foo), you'd get this object structure:

{ <package.json data>
, path: "/path/to"
, parent: null
, dependencies:
  { foo :
    { version: "1.2.3"
    , path: "/path/to/node_modules/foo"
    , parent: <Circular: root>
    , dependencies:
      { bar:
        { parent: <Circular: foo>
        , path: "/path/to/node_modules/foo/node_modules/bar"
        , version: "2.3.4"
        , dependencies: { baz: <Circular: foo.dependencies.baz> }
        }
      , baz: { ... }
      , asdf: <Circular: asdf>
      }
    }
  , asdf: { ... }
  }
}

Unmet deps are left as strings.
Extraneous deps are marked with extraneous:true
deps that don't meet a requirement are marked with invalid:true

to READ(packagefolder, parentobj, name, reqver)
obj = read package.json
installed = ./node_modules/*
if parentobj is null, and no package.json
  obj = {dependencies:{<installed>:"*"}}
deps = Object.keys(obj.dependencies)
obj.path = packagefolder
obj.parent = parentobj
if name, && obj.name !== name, obj.invalid = true
if reqver, && obj.version !satisfies reqver, obj.invalid = true
if !reqver && parentobj, obj.extraneous = true
for each folder in installed
  obj.dependencies[folder] = READ(packagefolder+node_modules+folder,
                                  obj, folder, obj.dependencies[folder])
# walk tree to find unmet deps
for each dep in obj.dependencies not in installed
  r = obj.parent
  while r
    if r.dependencies[dep]
      if r.dependencies[dep].verion !satisfies obj.dependencies[dep]
        WARN
        r.dependencies[dep].invalid = true
      obj.dependencies[dep] = r.dependencies[dep]
      r = null
    else r = r.parent
return obj


TODO:
1. Find unmet deps in parent directories, searching as node does up
as far as the left-most node_modules folder.
2. Ignore anything in node_modules that isn't a package folder.

*/

const npm = require('npm/lib/npm.js');
const fs = require('graceful-fs');
const path = require('path');
const semver = require('semver');
const log = require('log4js').getLogger('pluginfw');
const util = require('util');

let fuSeen = [];
let riSeen = [];
let rpSeen = {};

const readJson = (file, callback) => {
  fs.readFile(file, (er, buf) => {
    if (er) {
      callback(er);
      return;
    }
    try {
      callback(null, JSON.parse(buf.toString()));
    } catch (er) {
      callback(er);
    }
  });
};

const readInstalled = (folder, cb) => {
  /* This is where we clear the cache, these three lines are all the
   * new code there is */
  fuSeen = [];
  rpSeen = {};
  riSeen = [];

  const d = npm.config.get('depth');
  readInstalled_(folder, null, null, null, 0, d, (er, obj) => {
    if (er) return cb(er);
    // now obj has all the installed things, where they're installed
    // figure out the inheritance links, now that the object is built.
    resolveInheritance(obj);
    cb(null, obj);
  });
};

module.exports = readInstalled;

const readInstalled_ = (folder, parent, name, reqver, depth, maxDepth, cb) => {
  let installed,
    obj,
    real,
    link;
  let errState = null;
  let called = false;

  const next = (er) => {
    if (errState) return;
    if (er) {
      errState = er;
      return cb(null, []);
    }
    if (!installed || !obj || !real || called) return;
    called = true;
    if (rpSeen[real]) return cb(null, rpSeen[real]);
    if (obj === true) {
      obj = {dependencies: {}, path: folder};
      for (const i of installed) {
        obj.dependencies[i] = '*';
      }
    }
    if (name && obj.name !== name) obj.invalid = true;
    obj.realName = name || obj.name;
    obj.dependencies = obj.dependencies || {};

    // "foo":"http://blah" is always presumed valid
    if (reqver &&
        semver.validRange(reqver) &&
        !semver.satisfies(obj.version, reqver)) {
      obj.invalid = true;
    }

    if (parent &&
        !(name in parent.dependencies) &&
        !(name in (parent.devDependencies || {}))) {
      obj.extraneous = true;
    }
    obj.path = obj.path || folder;
    obj.realPath = real;
    obj.link = link;
    if (parent && !obj.link) obj.parent = parent;
    rpSeen[real] = obj;
    obj.depth = depth;
    if (depth >= maxDepth) return cb(null, obj);
    Promise.all(installed.map(async (pkg) => {
      let rv = obj.dependencies[pkg];
      if (!rv && obj.devDependencies) rv = obj.devDependencies[pkg];
      const dir = path.resolve(folder, `node_modules/${pkg}`);
      const deps = obj.dependencies[pkg];
      return await util.promisify(readInstalled_)(dir, obj, pkg, deps, depth + 1, maxDepth);
    })).then((installedData) => {
      for (const dep of installedData) {
        obj.dependencies[dep.realName] = dep;
      }

      // any strings here are unmet things.  however, if it's
      // optional, then that's fine, so just delete it.
      if (obj.optionalDependencies) {
        for (const dep of Object.keys(obj.optionalDependencies)) {
          if (typeof obj.dependencies[dep] === 'string') {
            delete obj.dependencies[dep];
          }
        }
      }
      return cb(null, obj);
    }, (err) => cb(err || new Error(err)));
  };

  fs.readdir(path.resolve(folder, 'node_modules'), (er, i) => {
    // error indicates that nothing is installed here
    if (er) i = [];
    installed = i.filter((f) => f.charAt(0) !== '.');
    next();
  });

  readJson(path.resolve(folder, 'package.json'), (er, data) => {
    obj = copy(data);

    if (!parent) {
      obj = obj || true;
      er = null;
    }
    return next(er);
  });

  fs.lstat(folder, (er, st) => {
    if (er) {
      if (!parent) real = true;
      return next(er);
    }
    fs.realpath(folder, (er, rp) => {
      real = rp;
      if (st.isSymbolicLink()) link = rp;
      next(er);
    });
  });
};

// starting from a root object, call findUnmet on each layer of children
const resolveInheritance = (obj) => {
  if (typeof obj !== 'object') return;
  if (riSeen.indexOf(obj) !== -1) return;
  riSeen.push(obj);
  if (typeof obj.dependencies !== 'object') {
    obj.dependencies = {};
  }
  for (const dep of Object.keys(obj.dependencies)) {
    findUnmet(obj.dependencies[dep]);
  }
  for (const dep of Object.keys(obj.dependencies)) {
    resolveInheritance(obj.dependencies[dep]);
  }
};

// find unmet deps by walking up the tree object.
// No I/O
const findUnmet = (obj) => {
  if (typeof obj !== 'object') return;
  if (fuSeen.indexOf(obj) !== -1) return;
  fuSeen.push(obj);
  const deps = obj.dependencies = obj.dependencies || {};
  for (const d of Object.keys(deps).filter((d) => typeof deps[d] === 'string')) {
    let r = obj.parent;
    let found = null;
    while (r && !found && typeof deps[d] === 'string') {
      // if r is a valid choice, then use that.
      found = r.dependencies[d];
      if (!found && r.realName === d) found = r;

      if (!found) {
        r = r.link ? null : r.parent;
        continue;
      }
      if (typeof deps[d] === 'string' &&
          !semver.satisfies(found.version, deps[d])) {
        // the bad thing will happen
        log.warn(`${obj.path} requires ${d}@'${deps[d]}' but will load\n${found.path},\n` +
                 `which is version ${found.version}`, 'unmet dependency');
        found.invalid = true;
      }
      deps[d] = found;
    }
  }
};

const copy = (obj) => {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(copy);

  const o = {};
  for (const [i, v] of Object.entries(obj)) o[i] = copy(v);
  return o;
};

if (module === require.main) {
  const seen = [];

  const cleanup = (map) => {
    if (seen.indexOf(map) !== -1) return;
    seen.push(map);
    for (const i of Object.keys(map)) {
      switch (i) {
        case '_id':
        case 'path':
        case 'extraneous': case 'invalid':
        case 'dependencies': case 'name':
          continue;
        default: delete map[i];
      }
    }
    for (const dep of Object.values(map.dependencies || {})) {
      if (typeof dep === 'object') {
        cleanup(dep);
      }
    }
    return map;
  };

  const util = require('util');
  console.error('testing');

  let called = 0;
  npm.load({}, (err) => {
    if (err != null) throw err;
    readInstalled(process.cwd(), (er, map) => {
      console.error(called++);
      if (er) return console.error(er.stack || er.message);
      cleanup(map);
      console.error(util.inspect(map, true, 10, true));
    });
  });
}
