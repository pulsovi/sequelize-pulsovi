/*
 * Based on the work of https://github.com/filipesarturi
 *     at https://github.com/sequelize/sequelize/issues/11836
 */
const Sequelize = require('sequelize');
const { isArray, isNull, isUndefined } = require('underscore');

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
    const { associations, attributes } = this.constructor;

    this.associationsData = this.associationsData ?? [];
    await Promise.all(Object.entries(values).map(async([key, value]) => {
      const association = associations[key];

      if (isUndefined(association)) {
        if (isUndefined(attributes[key])) this[key] = value;
        else this.setDataValue(key, value);
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
      const createValue = this?.toObject?.() ?? this;
      const createOptions = association.throughModel ??
        { through: this[association.throughModel.name] };
      const instance = await parent[association.accessors.create](createValue, createOptions);

      return instance.fill(this).deepSave({ association, parent });
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
