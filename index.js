const path = require('path');
const stream = require('stream');
const fs = require('fs');
const url = require('url');
const querystring = require('querystring');
const http = require('http');
const https = require('https');
const child_process = require('child_process');

const CERT = fs.readFileSync('../exokit-backend/cert/fullchain.pem');
const PRIVKEY = fs.readFileSync('../exokit-backend/cert/privkey.pem');
const PORT = 3000;

const sdk = require('./sdk.js');
const t = require('./types.js');
const {genKeys} = require('./create-flow-account.js');
const {signingFunction} = require('./signing-function.js');
const flowJson = require('./flow.json');
const serviceAddress = flowJson.accounts.service.address;
const sf = signingFunction(flowJson.accounts.service.privateKey);

const _makePromise = () => {
  let accept, reject;
  const p = new Promise((a, r) => {
    accept = a;
    reject = r;
  });
  p.accept = accept;
  p.reject = reject;
  return p;
};

(async () => {

let contractsInitializeTriggered = false;
const contractsInitializedPromise = _makePromise();
const waitForContractsInitialized = async () => {
  if (!contractsInitializeTriggered) {
    contractsInitializeTriggered = true;

    (async () => {
      const metaKeys = genKeys();
      let metaAddr, metaSf;

      const acctResponse = await sdk.send(await sdk.pipe(await sdk.build([
        sdk.getAccount(serviceAddress),
      ]), [
        sdk.resolve([
          sdk.resolveParams,
        ]),
      ]), { node: "http://localhost:8080" });
      const seqNum = acctResponse.account.keys[0].sequenceNumber;

      {
        const code = `\
          pub contract MetaContract {
            pub resource Vault {
              pub var contracts: {String: Address}
              pub var keys: {String: String}
              init() {
                self.contracts = {}
                self.keys = {}
              }
            }

            init() {
              let vault <- create Vault()
              self.account.save(<-vault, to: /storage/MainVault)

              self.account.link<&Vault>(/public/Vault, target: /storage/MainVault)
            }
          }
        `;
        const response = await sdk.send(await sdk.pipe(await sdk.build([
          sdk.params([
            sdk.param(metaKeys.flowKey, t.Identity, "publicKey"),
            sdk.param(code ? ('[' + new TextEncoder().encode(code).map(n => '0x' + n.toString(16)).join(',') + ']') : '', t.Identity, "code"),
          ]),
          sdk.authorizations([sdk.authorization(serviceAddress, sf, 0)]),
          sdk.payer(sdk.authorization(serviceAddress, sf, 0)),
          sdk.proposer(sdk.authorization(serviceAddress, sf, 0, seqNum)),
          sdk.limit(100),
          sdk.transaction`
            transaction {
              let payer: AuthAccount
              prepare(payer: AuthAccount) {
                self.payer = payer
              }
              execute {
                let account = AuthAccount(payer: self.payer)
                account.addPublicKey("${p => p.publicKey}".decodeHex())
                account.setCode(${p => p.code})
              }
            }
          `,
        ]), [
          sdk.resolve([
            sdk.resolveParams,
            sdk.resolveAccounts,
            sdk.resolveSignatures,
          ]),
        ]), { node: "http://localhost:8080" });

        const response2 = await sdk.send(await sdk.pipe(await sdk.build([
          sdk.getTransactionStatus(response.transactionId),
        ]), [
          sdk.resolve([
            sdk.resolveParams,
          ]),
        ]), { node: "http://localhost:8080" });

        metaAddr = response2.transaction.events.length >= 1 ? response2.transaction.events[0].payload.value.fields[0].value.value.slice(2) : null;
        // console.log('got response', response2, metaAddr);
        metaSf = signingFunction(metaKeys.privateKey);
      }

      contractsInitializedPromise.accept({
        address: metaAddr,
        keys: metaKeys,
        sf: metaSf,
      });
    })();
  }
  return await contractsInitializedPromise;
};
const _handleContracts = async (req, res) => {
  const _respond = (statusCode, body) => {
    res.statusCode = statusCode;
    _setCorsHeaders(res);
    res.end(body);
  };
  const _setCorsHeaders = res => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
  };
  const _readBuffer = () => new Promise((accept, reject) => {
    const bs = [];
    req.on('data', b => {
      bs.push(b);
    });
    req.on('end', () => {
      const b = Buffer.concat(bs);
      accept(b);
    });
    req.on('error', reject);
  });

  const {method} = req;
  const {pathname: p, query: q} = url.parse(req.url, true);

  const metaContract = await waitForContractsInitialized();
  // console.log('got meta contract', metaContract);

  const _getContract = async p => {
    const response = await sdk.send(await sdk.pipe(await sdk.build([
      sdk.params([
        sdk.param(p, t.Identity, 'path'),
      ]),
      // sdk.authorizations([sdk.authorization(serviceAddress, sf, 0)]),
      // sdk.payer(sdk.authorization(serviceAddress, sf, 0)),
      // sdk.proposer(sdk.authorization(serviceAddress, sf, 0, seqNum)),
      sdk.script`
        import MetaContract from 0x${metaContract.address}

        pub fun main() : Address? {
          let publicAccount = getAccount(0x${metaContract.address})
          let capability = publicAccount.getCapability(/public/Vault)!
          let vaultRef = capability.borrow<&MetaContract.Vault>()!
          return vaultRef.contracts["${p => p.path}"]
        }
      `,
    ]), [
      sdk.resolve([
        sdk.resolveParams,
        sdk.resolveAccounts,
        sdk.resolveSignatures,
      ]),
    ]), { node: "http://localhost:8080" });
    if (response.encodedData.value) {
      const address = response.encodedData.value.value.slice(2);

      const response2 = await sdk.send(await sdk.pipe(await sdk.build([
        sdk.params([
          sdk.param(p, t.Identity, 'path'),
        ]),
        // sdk.authorizations([sdk.authorization(serviceAddress, sf, 0)]),
        // sdk.payer(sdk.authorization(serviceAddress, sf, 0)),
        // sdk.proposer(sdk.authorization(serviceAddress, sf, 0, seqNum)),
        sdk.script`
          import MetaContract from 0x${metaContract.address}

          pub fun main() : String? {
            let publicAccount = getAccount(0x${metaContract.address})
            let capability = publicAccount.getCapability(/public/Vault)!
            let vaultRef = capability.borrow<&MetaContract.Vault>()!
            return vaultRef.keys["${p => p.path}"]
          }
        `,
      ]), [
        sdk.resolve([
          sdk.resolveParams,
          sdk.resolveAccounts,
          sdk.resolveSignatures,
        ]),
      ]), { node: "http://localhost:8080" });
      const keys = JSON.parse(response2.encodedData.value.value);

      return {
        address,
        keys,
      };
    } else {
      return null;
    }
  };

  let match;
  if (method === 'OPTIONS') {
    // res.statusCode = 200;
    _setCorsHeaders(res);
    res.end();
  } else if (method === 'GET' && p === '/') {
    const response = await sdk.send(await sdk.pipe(await sdk.build([
      /* sdk.params([
        sdk.param('lol', t.Identity, 'key'),
      ]), */
      // sdk.authorizations([sdk.authorization(serviceAddress, sf, 0)]),
      // sdk.payer(sdk.authorization(serviceAddress, sf, 0)),
      // sdk.proposer(sdk.authorization(serviceAddress, sf, 0, seqNum)),
      sdk.script`
        import MetaContract from 0x${metaContract.address}

        pub fun main() : [String] {
          let publicAccount = getAccount(0x${metaContract.address})
          let capability = publicAccount.getCapability(/public/Vault)!
          let vaultRef = capability.borrow<&MetaContract.Vault>()!
          return vaultRef.contracts.keys
        }
      `,
    ]), [
      sdk.resolve([
        sdk.resolveParams,
        sdk.resolveAccounts,
        sdk.resolveSignatures,
      ]),
    ]), { node: "http://localhost:8080" });
    const keys = response.encodedData.value.map(o => o.value);
    _respond(200, JSON.stringify(keys));
  } else if (method === 'GET') {
    const j = await _getContract(p);
    _setCorsHeaders(res);
    res.end(JSON.stringify(j, null, 2));
  } else if (method === 'PUT') {
    const b = await _readBuffer();
    const code = b.toString('utf8');

    const oldContract = await _getContract(p);
    console.log('got old contract', oldContract);

    if (!oldContract) {
      const keys2 = genKeys();
      let addr2, sf2;
      {
        const acctResponse = await sdk.send(await sdk.pipe(await sdk.build([
          sdk.getAccount(serviceAddress),
        ]), [
          sdk.resolve([
            sdk.resolveParams,
          ]),
        ]), { node: "http://localhost:8080" });
        const seqNum = acctResponse.account.keys[0].sequenceNumber;

        const response = await sdk.send(await sdk.pipe(await sdk.build([
          sdk.params([
            sdk.param(keys2.flowKey, t.Identity, "publicKey"),
            sdk.param(code ? ('[' + new TextEncoder().encode(code).map(n => '0x' + n.toString(16)).join(',') + ']') : '', t.Identity, "code"),
            sdk.param(q.userFlowKey || '', t.Identity, "userFlowKey"),
            sdk.param(p, t.Identity, "path"),
          ]),
          sdk.authorizations([sdk.authorization(serviceAddress, sf, 0)]),
          sdk.payer(sdk.authorization(serviceAddress, sf, 0)),
          sdk.proposer(sdk.authorization(serviceAddress, sf, 0, seqNum)),
          sdk.limit(100),
          sdk.transaction`
            import MetaContract from 0x${metaContract.address}

            transaction {
              let payer: AuthAccount
              prepare(payer: AuthAccount) {
                self.payer = payer
              }
              execute {
                let account = AuthAccount(payer: self.payer)
                account.addPublicKey("${p => p.publicKey}".decodeHex())
                ${p => p.code ? `account.setCode(${p.code})` : ''}
                ${p => p.userFlowKey ? `account.addPublicKey("${p.userFlowKey}".decodeHex())` : ''}
              }
            }
          `,
        ]), [
          sdk.resolve([
            sdk.resolveParams,
            sdk.resolveAccounts,
            sdk.resolveSignatures,
          ]),
        ]), { node: "http://localhost:8080" });
        console.log('got contract response 1', response.transactionId);

        const response2 = await sdk.send(await sdk.pipe(await sdk.build([
          sdk.getTransactionStatus(response.transactionId),
        ]), [
          sdk.resolve([
            sdk.resolveParams,
          ]),
        ]), { node: "http://localhost:8080" });
        console.log('got contract response 2', response2);

        addr2 = response2.transaction.events.length >= 1 ? response2.transaction.events[0].payload.value.fields[0].value.value.slice(2) : null;
        sf2 = signingFunction(keys2.privateKey);
      }
      {
        const acctResponse = await sdk.send(await sdk.pipe(await sdk.build([
          sdk.getAccount(metaContract.address),
        ]), [
          sdk.resolve([
            sdk.resolveParams,
          ]),
        ]), { node: "http://localhost:8080" });
        const seqNum = acctResponse.account.keys[0].sequenceNumber;

        const response = await sdk.send(await sdk.pipe(await sdk.build([
          sdk.params([
            sdk.param(p, t.Identity, "path"),
            sdk.param(addr2, t.Address, "address"),
            sdk.param(JSON.stringify(JSON.stringify(keys2)), t.String, "keys"),
          ]),
          sdk.authorizations([sdk.authorization(metaContract.address, metaContract.sf, 0)]),
          sdk.payer(sdk.authorization(metaContract.address, metaContract.sf, 0)),
          sdk.proposer(sdk.authorization(metaContract.address, metaContract.sf, 0, seqNum)),
          sdk.limit(100),
          sdk.transaction`
            import MetaContract from 0x${metaContract.address}

            transaction {
              let payer: AuthAccount
              prepare(payer: AuthAccount) {
                self.payer = payer
              }
              execute {
                let v <- self.payer.load<@MetaContract.Vault>(from: /storage/MainVault)!
                v.contracts["${p => p.path}"] = 0x${p => p.address}
                v.keys["${p => p.path}"] = ${p => p.keys}
                self.payer.save(<-v, to: /storage/MainVault)
              }
            }
          `,
        ]), [
          sdk.resolve([
            sdk.resolveParams,
            sdk.resolveAccounts,
            sdk.resolveSignatures,
          ]),
        ]), { node: "http://localhost:8080" });
        console.log('got contract response 3', response.transactionId);

        const response2 = await sdk.send(await sdk.pipe(await sdk.build([
          sdk.getTransactionStatus(response.transactionId),
        ]), [
          sdk.resolve([
            sdk.resolveParams,
          ]),
        ]), { node: "http://localhost:8080" });
        console.log('got contract response 4', response2);
      }

      _setCorsHeaders(res);
      res.end(JSON.stringify({
        created: true,
        address: addr2,
        keys: keys2,
      }, null, 2));
    } else {
      if (code) {
        const address = oldContract.address;
        const sf = signingFunction(oldContract.keys.privateKey);
        const acctResponse = await sdk.send(await sdk.pipe(await sdk.build([
          sdk.getAccount(address),
        ]), [
          sdk.resolve([
            sdk.resolveParams,
          ]),
        ]), { node: "http://localhost:8080" });
        const seqNum = acctResponse.account.keys[0].sequenceNumber;

        const response = await sdk.send(await sdk.pipe(await sdk.build([
          sdk.params([
            // sdk.param(keys2.flowKey, t.Identity, "publicKey"),
            sdk.param(code ? ('[' + new TextEncoder().encode(code).map(n => '0x' + n.toString(16)).join(',') + ']') : '', t.Identity, "code"),
            // sdk.param(q.userFlowKey || '', t.Identity, "userFlowKey"),
          ]),
          sdk.authorizations([sdk.authorization(address, sf, 0)]),
          sdk.payer(sdk.authorization(address, sf, 0)),
          sdk.proposer(sdk.authorization(address, sf, 0, seqNum)),
          sdk.limit(100),
          sdk.transaction`
            transaction {
              let payer: AuthAccount
              prepare(payer: AuthAccount) {
                self.payer = payer
              }
              execute {
                self.payer.setCode(${p => p.code})
              }
            }
          `,
        ]), [
          sdk.resolve([
            sdk.resolveParams,
            sdk.resolveAccounts,
            sdk.resolveSignatures,
          ]),
        ]), { node: "http://localhost:8080" });
        console.log('got update contract response 1', response.transactionId);

        const response2 = await sdk.send(await sdk.pipe(await sdk.build([
          sdk.getTransactionStatus(response.transactionId),
        ]), [
          sdk.resolve([
            sdk.resolveParams,
          ]),
        ]), { node: "http://localhost:8080" });
        console.log('got update contract response 2', response2);

        // addr2 = response2.transaction.events.length >= 1 ? response2.transaction.events[0].payload.value.fields[0].value.value.slice(2) : null;
        _setCorsHeaders(res);
        res.end(JSON.stringify({
          updated: true,
          address: oldContract.address,
          keys: oldContract.keys,
        }, null, 2));
      } else {
        _setCorsHeaders(res);
        res.end(JSON.stringify({
          address: oldContract.address,
          keys: oldContract.keys,
        }, null, 2));
      }
    }
  } else {
    _respond(404, 'not found');
  }
};

const _req = (protocol, port) => (req, res) => {
try {

  const o = url.parse(protocol + '//' + (req.headers['host'] || '') + req.url);
  let match;
  if (o.host === `contracts.exokit.org:${port}`) {
    _handleContracts(req, res);
    return;
  }

  res.statusCode = 404;
  res.end('host not found');
} catch(err) {
  console.warn(err.stack);

  res.statusCode = 500;
  res.end(err.stack);
}
};

const server = http.createServer(_req('http:', PORT));
// server.on('upgrade', _ws);
const server2 = https.createServer({
  cert: CERT,
  key: PRIVKEY,
}, _req('https:', PORT + 1));
// server2.on('upgrade', _ws);

const _warn = err => {
  console.warn('uncaught: ' + err.stack);
};
process.on('uncaughtException', _warn);
process.on('unhandledRejection', _warn);

server.listen(PORT);
server2.listen(PORT + 1);

child_process.spawn('flow', [
  'emulator',
  'start',
  '-v',
  '--persist',
  '--http-port', 4000 + '',
], {
  stdio: 'inherit',
});

console.log(`http://127.0.0.1:${PORT}`);
console.log(`http://127.0.0.1:443`);

})();
