/*
 * Based on the work of https://github.com/filipesarturi
 *     at https://github.com/sequelize/sequelize/issues/11836
 */
const log = require('debug')('sequelize-schemas:Model');
const Sequelize = require('sequelize');
const { isArray, isNull, isObject, isUndefined } = require('underscore');

function getFilledModelInstance({ data, deepPath, model: Schema }) {
  const instance = data instanceof Schema ? data : new Schema();

  if (deepPath) instance.deepPath = deepPath;
  return instance.fill(data);
}

class Model extends Sequelize.Model {
  constructor(...args) {
    super(...args);
    this.deepPath = this.constructor.name;
    this.associationsData = [];
  }

  async fill(values) {
    const { associations, tableAttributes: attributes } = this.constructor;

    await Promise.all(Object.entries(values).map(async([key, value]) => {
      const association = associations[key];

      if (isUndefined(association)) {
        if (isUndefined(attributes[key])) {
          log(`WARNING ${key} key: it's not an attribute (maybe a throughModel values ?)`);
          this[key] = value;
          return;
        }
        if (isObject(value)) {
          log(`WARNING ${key} key: it's not a primitive value`);
          // this[key] = value;
          return;
        }
        if (
          (this.constructor.primaryKeyAttributes || []).includes(key) &&
         !(isNull(this[key]) || isUndefined(this[key]))
        ) {
          log(`SKIP ${key} key: it's a primary key and it's already set`);
          return;
        }
        this.setDataValue(key, value);
        return;
      }
      const model = association.target;

      this.associationsData.push([association, await (isArray(value) ?
        Promise.all(value.map((data, index) => getFilledModelInstance({
          data,
          deepPath: `${this.deepPath}.${association.associationAccessor}[${index}]`,
          model,
        }))) :
        getFilledModelInstance({
          data: value,
          deepPath: `${this.deepPath}.${association.associationAccessor}`,
          model,
        })
      )]);
    }));

    this.isNewRecord = this.getIsNewRecord();
    return this;
  }

  async deepSave({ association, parent } = {}) {
    if (this.isNewRecord && parent) {
      const createOptions = association.throughModel ?
        { through: this[association.throughModel.name] } :
        {}.undefined;
      const instance = await parent[association.accessors.create](this, createOptions);

      return await instance.fill(this).deepSave({ association, parent });
    }

    await this.save();
    await Promise.all(this.associationsData ?? []).map(async([assoc, value]) => {
      await Promise.all((isArray(value) ? value : [value])
        .map(item => item.deepSave({ association: assoc, parent: this }), this));
      return this[assoc.accessors.set](value);
    }, this);
    return this;
  }

  async fillAndSave(values) {
    await this.fill(values);

    return this.deepSave();
  }

  getIsNewRecord() {
    const primaryKeyAttributes = this.constructor.primaryKeyAttributes || [];

    if (!primaryKeyAttributes.length) return {}.undefined;
    return primaryKeyAttributes
      .some(primaryKeyAttribute => isNull(this[primaryKeyAttribute]) ||
        isUndefined(this[primaryKeyAttribute]));
  }
}

module.exports = Model;
module.exports.default = Model;
module.exports.Model = Model;
