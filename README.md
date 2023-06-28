jifro
=====

jifro is a feature-reduced fork of
[jify](https://github.com/mohd-akram/jify), an experimental
library/tool for querying large (GBs) JSON files. It does this by
consuming an index over the required fields.

In contrast to jify, jifro is read-only, i.e. it can only query a
JSON file with an existing index but it can’t modify either.

Building the index must be done in jify proper before jifro can use
it. When a JSON file is indexed (eg. `data.json`), an index file is created in the same directory with a `.index.json` extension (eg.
`data.index.json`).

Why?
----

One might ask why one would want a separate, immutable version of
jify rather than just ignore jify’s write-access features.

The answer is that jify’s write-access features are using native
code via jify’s `os-lock` dependency. While using native modules is
usually not an issue, they can cause issues when one tries to use
them on specific hosting platforms such as Electron apps.

In other words, embedding the library inside an Electron app is
easier if it doesn’t use native code. For use cases where read-only
access is sufficient, this fork may be a useful trade-off.

Install
-------

```shell
npm install jifro
```

Usage
-----

At development/build time (using jify):

```javascript
const { Database } = require('jify');

async function main() {
  // Must be created and indexed by jify
  const db = new Database('books.json');

  // Create
  await db.create();

  // Insert - Single
  await db.insert({
    title: 'Robinson Crusoe',
    year: 1719,
    author: { name: 'Daniel Defoe' }
  });

  // Insert - Batch
  await db.insert([
    {
      title: 'Great Expectations',
      year: 1861,
      author: { name: 'Charles Dickens' }
    },
    {
      title: 'Oliver Twist',
      year: 1838,
      author: { name: 'Charles Dickens' }
    },
    {
      title: 'Pride and Prejudice',
      year: 1813,
      author: { name: 'Jane Austen' }
    },
    {
      title: 'Nineteen Eighty-Four',
      year: 1949,
      author: { name: 'George Orwell' }
    }
  ]);

  // Index - creates books.index.json file
  await db.index('title', 'year', 'author.name');
}

main();
```

Then, at runtime (using jifro):

```javascript
const { Database, predicate: p } = require('jifro');

async function main() {
  // The same JSON file that jify created earlier
  const db = new Database('books.json');

  // Query
  console.log('author.name = Charles Dickens, year > 1840');
  const query = { 'author.name': 'Charles Dickens', year: p`> ${1840}` };
  for await (const record of db.find(query))
    console.log(record);

  let records;

  // Range query
  console.log('1800 <= year < 1900');
  records = await db.find({ year: p`>= ${1800} < ${1900}` }).toArray();
  console.log(records);

  // Multiple queries
  console.log('year < 1800 or year > 1900');
  records = await db.find(
    { year: p`< ${1800}` }, { year: p`> ${1900}` }
  ).toArray();
  console.log(records);
}

main();
```

CLI
---

```shell
jifro find --query "author.name=Charles Dickens,year>1840" books.json
jifro find --query "year>=1800<1900" books.json
jifro find --query "year<1800" --query "year>1900" books.json
```

Implementation
--------------

The index is implemented as a JSON array of skip list entries. The entries are
encoded as strings and all numbers embedded in the string are encoded using
[Z85](https://rfc.zeromq.org/spec:32/Z85/). This implementation was chosen for
its simplicity and to allow for using a single JSON file as an index. Better
performance might be achieved by using a different data structure, a binary
format, or multiple index files.

Performance
-----------

jify (and, by extension, jifro) is reasonably fast. Query time is
< 5ms for the first result + (0.1ms find + 0.1ms fetch) per
subsequent result. All tests on a MBP 2016 base model.

Credits
-------

Credits go to @mohd-akram, the original author of jify.
