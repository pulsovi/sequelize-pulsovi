const fs = require('fs');
const path = require('path');

const promiseNC = require('promise-no-callback');
const Sequelize = require('sequelize');
const sequelizeTransforms = require('sequelize-transforms');
const { has, isArray, isObject, isString } = require('underscore-pulsovi');

class SequelizePulsovi {
  constructor(options) {
    Object.assign(this, {
      logging: false,
      retryTimeout: 2000,
      schemasDir: path.join(process.cwd(), 'schemas'),
    }, options);
    this.init();
  }

  async init() {
    const { promise, resolve, reject } = promiseNC();

    this.ready = promise;
    this.getSequelize();
    await this.getSchemasList();
    this.makeSchemas();
    this.associateSchemas();
    await this.connect(resolve, reject);
  }

  connect(resolve, reject) {
    this.sequelize.transaction(transaction => {
      const sync = this.sequelize.sync({ force: false, transaction });

      sync.then(() => {
        resolve(this);
        console.info('Connected to database.');
      }).catch(error => {
        reject(error);
        console.error('Unable to connect to the database:', error);
      });

      return sync;
    }).catch(err => {
      setTimeout(() => this.connect(resolve, reject), this.retryTimeout);
      throw err;
    });
  }

  getSequelize() {
    this.sequelize = new Sequelize(this.database, this.username, this.password, {
      define: {
        charset: 'utf8',
        collate: 'utf8_general_ci',
        underscored: true,
      },
      dialect: this.dialect,
      host: this.host,
      logging: this.logging,
    });
  }

  async getSchemasList() {
    const schemas = await fs.promises.readdir(this.schemasDir, { withFileTypes: true });

    this.schemas = schemas
      .filter(dirent => dirent.isFile())
      .map(file => file.name)
      .filter(filename => path.extname(filename) === '.js')
      .map(filename => path.basename(filename, path.extname(filename)));
  }

  makeSchemas() {
    this.schemas.forEach(schema => {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const schemaModule = require(path.join(this.schemasDir, schema));
      const { attributes, hooks, methods, options, statics } = schemaModule;
      const defineOptions = { modelName: schema, ...options, hooks, ...this.defineOptions };
      const Schema = this.sequelize.define(schema.toLowerCase(), attributes, defineOptions);

      sequelizeTransforms(Schema);
      Object.assign(Schema, statics);
      Object.assign(Schema.prototype, methods);
      Schema.module = schemaModule;
      this[schema] = Schema;
    });
  }

  associateSchemas() {
    this.schemas.forEach(schema => {
      const { associations = {}} = this[schema];

      if (associations.oneToMany)
        associations.oneToMany.forEach(associate(schema, 'belongsTo', 'hasMany'));

      if (associations.manyToMany) {
        associations.manyToMany
          .map(bSchema => {
          // array to object
            if (!isArray(bSchema)) return bSchema;
            const [table, options, reverseOptions] = bSchema;
            return { options, reverseOptions, table };
          })
          .map(bSchema => {
          // through must be the same
            if (!isObject(bSchema))
              throw new TypeError(`bSchema must be either array or object ${typeof bSchema} found`);
            const { options = {}, reverseOptions = {}, table } = bSchema;

            // reverseOptions can be `false` to disable reverse bonding
            if (reverseOptions) {
              if (isString(options.through) && has(exports, options.through))
                options.through = exports[options.through];
              if (isString(reverseOptions.through) && has(exports, reverseOptions.through))
                reverseOptions.through = exports[reverseOptions.through];
              options.through = options.through || reverseOptions.through;
              reverseOptions.through = reverseOptions.through || options.through;
              if (reverseOptions.through !== options.through)
                throw new Error('options.through and reverseOptions.through must be the same');
            }
            return { options, reverseOptions, table };
          })
          .forEach(associate(schema, 'belongsToMany', 'belongsToMany'));
      }
    });
  }
}

function associate(aTable, aToB, bToA) {
  return function associateTo(bSchema) {
    let bTable = null;
    let options = null;
    let reverseOptions = null;

    try {
      ({ bTable, options, reverseOptions } = parseOptions(bSchema));
      if (!isString(bTable) || !has(exports, bTable))
        throw new ReferenceError(`There is no table nammed ${bTable}`);
      // reverseOptions can be `false` to disable reverse bonding
      if (reverseOptions) exports[bTable][bToA](exports[aTable], { ...reverseOptions });
      exports[aTable][aToB](exports[bTable], options);
    } catch (error) {
      const at = `\n    at ${path.resolve('./schemas/', `${aTable}.js`)}` +
      `\n        associations with ${bTable}`;

      error.message += at;
      throw error;
    }
  };

  function parseOptions(bSchema) {
    let bTable = null;
    let options = {};
    let reverseOptions = {};

    if (isString(bSchema)) bTable = bSchema;
    else if (isArray(bSchema))
      [bTable, options, reverseOptions = {}] = bSchema;
    else if (isObject(bSchema))
      ({ table: bTable, options, reverseOptions = {}} = bSchema);
    else {
      throw new TypeError(
        `bSchema must be either string, array or object ${typeof bSchema} found`
      );
    }

    return { bTable, options, reverseOptions };
  }
}

module.exports = SequelizePulsovi;
