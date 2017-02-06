'use strict';

const exec = require('child_process').exec;
const expect = require('chai').expect;
const _ = require('lodash');
const Promise = require('bluebird');
const consul = require('consul');

const execute = (commandLine) => {
  return new Promise((resolve, reject) => {
    exec(commandLine, {
      cwd: __dirname,
      env: process.env
    }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
      } else {
        resolve({
          stdout: stdout,
          stderr: stderr
        });
      }
    });
  });
};

describe('consul-kv-sync', () => {
  const config = {
    host: process.env.CONSUL_HOST || 'consul.service.consul',
    port: process.env.CONSUL_PORT || '8500',
    secure: process.env.CONSUL_SECURE === 'true'
  };

  const client = consul(config);
  Promise.promisifyAll(client.kv);

  after(() => {
    return client.kv.delAsync({
      key: 'service',
      recurse: true
    })
    .then(() => {
      return client.kv.delAsync({
        key: 'service2',
        recurse: true
      });
    })
    .then(() => {
      return client.kv.delAsync({
        key: 'other_service',
        recurse: true
      });
    });
  });

  describe('#validation', () => {
    it('should return an error when an empty config file is added', () => {
      return execute('node ../consul-kv-sync.js ./one.json ./two.json ./empty.json')
        .then(() => {
          throw new Error('Expected failure, got success');
        })
        .catch((err) => {
          expect(err.code).to.eql(99);
        });
    });
    it('should return an error when a config file with multiple top-level nodes is added', () => {
      return execute('node ../consul-kv-sync.js ./one.json ./two.json ./full.json')
        .then(() => {
          throw new Error('Expected failure, got success');
        })
        .catch((err) => {
          expect(err.code).to.eql(99);
        });
    });
    it('should return an error when an different service\'s config file is added', () => {
      return execute('node ../consul-kv-sync.js ./one.json ./two.json ./other.json')
        .then(() => {
          throw new Error('Expected failure, got success');
        })
        .catch((err) => {
          expect(err.code).to.eql(99);
        });
    });
  });

  describe('#run', () => {
    let response;
    describe('first run scenario', () => {
      before(() => {
        return client.kv.delAsync({
          key: 'service',
          recurse: true
        })
        .then(() => {
          return execute('node ../consul-kv-sync.js ./one.json ./two.json ./three.yaml');
        }).then(() => {
          return client.kv.getAsync({
            key: 'service',
            recurse: true
          });
        }).then((res) => {
          response = res;
        });
      });

      it('should set value to correct value', () => {
        let item = response.find((item) => {
          return item.Key === 'service/two';
        });

        expect(item).to.be.ok;
        expect(item.Value).to.eql('value 2');
      });

      it('should set value to correct value from a yaml file', () => {
        let item = response.find((item) => {
          return item.Key === 'service/yaml';
        });

        expect(item).to.be.ok;
        expect(item.Value).to.eql('it works');
      });

      it('should set overridden value to correct value', () => {
        let item = response.find((item) => {
          return item.Key === 'service/one';
        });

        expect(item).to.be.ok;
        expect(item.Value).to.eql('value from file two');
      });

      it('should set array parameters correctly', () => {
        let items = _.filter(response, (item) => {
          return /^service\/arrayparam/.test(item.Key);
        });

        expect(items.length).to.eql(4);
        expect(items[0].Key).to.eql('service/arrayparam/0');
        expect(items[0].Value).to.eql('1');
        expect(items[1].Value).to.eql('2');
        expect(items[2].Value).to.eql('3');
        expect(items[3].Value).to.eql('4');
      });
    });

    describe('second run scenario', () => {
      before(() => {
        return client.kv.setAsync({
          key: 'service/four',
          value: 'value for removal'
        }).then(() => {
          return client.kv.setAsync({
            key: 'service2/item',
            value: 'this value should stay'
          });
        }).then(() => {
          return client.kv.setAsync({
            key: 'service/one',
            value: 'this value should be changed'
          });
        }).then(() => {
          return execute('node ../consul-kv-sync.js ./one.json ./two.json');
        }).then(() => {
          return client.kv.getAsync({
            key: 'service',
            recurse: true
          });
        }).then(function(result) {
          response = result;
        });
      });

      it('should set value to correct value', () => {
        let item = response.find((item) => {
          return item.Key === 'service/two';
        });

        expect(item).to.be.ok;
        expect(item.Value).to.eql('value 2');
      });

      it('should set overridden value to correct value', () => {
        let item = response.find((item) => {
          return item.Key === 'service/one';
        });

        expect(item).to.be.ok;
        expect(item.Value).to.eql('value from file two');
      });

      it('should set array parameters correctly', () => {
        let items = _.filter(response, (item) => {
          return /^service\/arrayparam/.test(item.Key);
        });

        expect(items.length).to.eql(4);
        expect(items[0].Key).to.eql('service/arrayparam/0');
        expect(items[0].Value).to.eql('1');
        expect(items[1].Value).to.eql('2');
        expect(items[2].Value).to.eql('3');
        expect(items[3].Value).to.eql('4');
      });

      it('should remove existing keys that are not in config file', () => {
        let items = _.filter(response, (item) => {
          return item.Key === 'service/four';
        });

        expect(items.length).to.eql(0);
      });

      it('should not impact keys for a different service', () => {
        return client.kv.getAsync({
          key: 'service2/item'
        }).then((item) => {
          expect(item.Value).to.eql('this value should stay');
        });
      });
    });
  });
});
