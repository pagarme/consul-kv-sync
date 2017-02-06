'use strict';

const YAML = require('yamljs')
const jptr = require('json-ptr');
const Promise = require('bluebird');
const readFile = Promise.promisify(require('fs').readFile);
const _ = require('lodash');
const log = require('./logger');

/*
 * Creates a workflow that will synchronize one or more JSON files with consul's key-value store.
 * @param client - a consul client, requires that kv functions have been promisified
 * @param {Array} files - list of files to synchronize
 */
module.exports = (client, files) => {
  let workflow = { stats: { put: 0, deleted: 0 }, config: null };

  /*
   * Reads json pointers for the given file name and validates each file.
   * Also figures out what the prefix is for the consul keys we are updating.
   * @param {String} fileName - the file to read
   * @returns {Promise} when resolved, an array of pointer-values for the file.
   */
  const readPointers = (fileName) => {
    return readFile(fileName, 'utf8')
      .then((content) => {
        if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) {
          return YAML.parse(content)
        } else if (fileName.endsWith('.json')) {
          return JSON.parse(content)
        } else {
          throw new Error('')
        }
      })
      .then((contents) => {
        log.debug(`Read ${fileName}:`);
        log.debug(contents);
        let keys = _.keys(contents);
        if (keys.length !== 1) {
          throw new Error(`Each configuration file must have a single top-level node identifying the service. "${fileName}" has '${keys.length}' top-level nodes.`);
        }
        let pointers = jptr.list(contents);
        let prefix = pointers[1].pointer.substring(1);
        if (workflow.prefix) {
          if (prefix !== workflow.prefix) {
            throw new Error(`Each file must have the same top-level node. Expected "${fileName}'" to have top-level node "${workflow.prefix}", but it has "${prefix}".`);
          }
        } else {
          workflow.prefix = prefix;
        }
        return pointers;
      });
  };

  /*
   * Filters and reduces the array of pointers into an object
   * with the keys being the pointers and the values being the values.
   * Only items with non-object or array values are retrieved.
   * @param [Array] flattened - the array of pointers to work on
   * @returns [Promise] when fulfilled, a hash containing the keys and values
   */
  const reduce = (flattened) => {
    let reduced = _.reduce(_.filter(flattened, (x) => {
      return _.isString(x.value) || _.isFinite(x.value);
    }), function (acc, item) {
      acc[item.pointer.substring(1)] = item.value;
      return acc;
    }, {});
    workflow.config = reduced;
    return reduced;
  };

  /*
   * Retrieves the list of keys that currently exist in consul.
   */
  const getExistingKeys = () => {
    log.debug('Getting all keys for ' + workflow.prefix);
    return client.kv.keysAsync(`${workflow.prefix}/`)
      .catch((err) => {
        if (err.message === 'not found') {
          return [];
        }
        throw err;
      })
      .then((keys) => {
        log.debug('Keys: ', keys);
        workflow.existing = keys;
      });
  };

  /*
   * PUTs all of the keys and values into consul. Tracks which ones have
   * been PUT so we can delete the remaining keys.
   */
  const put = () => {
    return Promise.all(_.map(workflow.config, (value, key) => {
      workflow.stats.put++;
      workflow.existing = _.filter(workflow.existing, (item) => {
        return item !== key;
      });
      log.debug(`Setting "${key}" to "${value}"`);
      return client.kv.setAsync({
        key: key,
        value: '' + value
      });
    }));
  };

  /*
   * DELETE any existing keys that have not been PUT.
   */
  const del = () => {
    return Promise.map(workflow.existing, function(key) {
      workflow.stats.deleted++;
      log.debug(`Deleting "${key}"`);
      return client.kv.delAsync(key);
    }).then(() => {
      delete workflow.existing;
    });
  };

  /*
   * Executes the workflow
   */
  workflow.exec = () => {
    return Promise.map(files, readPointers)
      .then(_.flatten)
      .then(reduce)
      .then(getExistingKeys)
      .then(put)
      .then(del);
  };

  return workflow;
};
