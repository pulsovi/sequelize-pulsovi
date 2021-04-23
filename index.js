const fs = require('fs');
const path = require('path');

const promiseNC = require('promise-no-callback');
const Sequelize = require('sequelize');
const sequelizeTransforms = require('sequelize-transforms');
const { has, isArray, isEmpty, isObject, isString } = require('underscore');

class SequelizePulsovi {
  constructor(options) {
    Object.assign(this, {
      logging: false,
      retryTimeout: 2000,
      schemasDir: path.join(process.cwd(), 'schemas'),
      syncOptions: { force: false, ...options.sync },
    }, options);
    this.init();
  }

  async init() {
    const { promise, resolve, reject } = promiseNC();

    this.ready = promise;
    this.getSequelize();
    this.getSchemasList();
    this.makeSchemas();
    this.associateSchemas();
    await this.connect(resolve, reject);
  }

  associate(type, aTable, options) {
    try {
      if (type === 'oneToMany') return this.associateOneToMany(aTable, options);
      if (type === 'manyToMany') return this.associateManyToMany(aTable, options);
      throw new TypeError(`Unable to make ${type} association.`);
    } catch (error) {
      const at = `\n    at ${path.resolve(this.schemasDir, `${aTable}.js`)}` +
      `\n        associations with ${JSON.stringify(options)}`;

      error.message += at;
      throw error;
    }
  }

  associateManyToMany(aTable, associationOptions) {
    const options = Object.assign(parseAssociationOptions(associationOptions), {
      aTable,
      aToB: 'belongsToMany',
      bToA: 'belongsToMany',
    });
    const { reverseOptions, rightOptions } = options;

    if (isObject(reverseOptions)) {
      if (isString(rightOptions.through) && has(this, rightOptions.through))
        rightOptions.through = this[rightOptions.through];
      if (isString(reverseOptions.through) && has(this, reverseOptions.through))
        reverseOptions.through = this[reverseOptions.through];
      rightOptions.through = rightOptions.through || reverseOptions.through;
      reverseOptions.through = reverseOptions.through || rightOptions.through;
      if (reverseOptions.through !== rightOptions.through)
        throw new Error('rightOptions.through and reverseOptions.through must be the same');
    }

    return this.makeAssociation(options);
  }

  associateOneToMany(aTable, associationOptions) {
    const options = Object.assign(parseAssociationOptions(associationOptions), {
      aTable,
      aToB: 'belongsTo',
      bToA: 'hasMany',
    });
    return this.makeAssociation(options);
  }

  associateSchema(schema) {
    const { associations = {}} = this[schema].module;

    Object.keys(associations).forEach(type => {
      associations[type].forEach(this.associate.bind(this, type, schema));
    });
  }

  associateSchemas() {
    this.schemas.forEach(schema => this.associateSchema(schema));
  }

  connect(resolve, reject) {
    this.sequelize.transaction(transaction => {
      const sync = this.sequelize.sync({ ...this.syncOptions, transaction });

      sync.then(() => {
        resolve(this);
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

  getSchemasList() {
    // eslint-disable-next-line no-sync
    const schemas = fs.readdirSync(this.schemasDir, { withFileTypes: true });

    this.schemas = schemas
      .filter(dirent => dirent.isFile())
      .map(file => file.name)
      .filter(filename => path.extname(filename) === '.js')
      .map(filename => path.basename(filename, path.extname(filename)));
  }

  makeAssociation(options) {
    // { aTable, bTable, aToB, bToA, rightOptions, reverseOptions }
    const { aTable, bTable } = options;
    const aSchema = this[aTable];
    const bSchema = this[bTable];
    const { bToA, aToB } = options;

    if (!isString(bTable) || !has(this, bTable)) {
      throw new ReferenceError(`There is no table nammed ${bTable},` +
      ` allowed names are :\n\t${this.schemas.join('\n\t')}`);
    }

    if (!isEmpty(options.reverseOptions)) bSchema[bToA](aSchema, { ...options.reverseOptions });
    aSchema[aToB](bSchema, options.rightOptions);
  }

  makeSchema(schema) {
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
  }

  makeSchemas() {
    this.schemas.forEach(schema => this.makeSchema(schema));
  }
}

function parseAssociationOptions(options) {
  let bTable = null;
  let rightOptions = {};
  let reverseOptions = {};

  if (isString(options)) bTable = options;
  else if (isArray(options))
    [bTable, rightOptions = {}, reverseOptions = {}] = options;
  else if (isObject(options))
    ({ table: bTable, options: rightOptions = {}, reverseOptions = {}} = options);
  else {
    throw new TypeError(
      `options must be either string, array or object ${typeof options} found`
    );
  }

  return { bTable, reverseOptions, rightOptions };
}

module.exports = SequelizePulsovi;
