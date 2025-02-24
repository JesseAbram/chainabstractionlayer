import * as bitcoin from 'bitcoinjs-lib'
import BigNumber from 'bignumber.js'
import Provider from '@liquality/provider'
import {
  calculateFee
} from '@liquality/bitcoin-utils'
import { addressToString, sleep } from '@liquality/utils'
import networks from '@liquality/bitcoin-networks'

import { version } from '../package.json'

export default class BitcoinSwapProvider extends Provider {
  constructor (chain = { network: networks.bitcoin }, mode = 'p2wsh') {
    super()
    this._network = chain.network
    if (!['p2wsh', 'p2shSegwit', 'p2sh'].includes(mode)) {
      throw new Error('Mode must be one of p2wsh, p2shSegwit, p2sh')
    }
    this._mode = mode
  }

  getPubKeyHash (address) {
    // TODO: wrapped segwit addresses not supported. Not possible to derive pubkeyHash from address
    try {
      const bech32 = bitcoin.address.fromBech32(address)
      return bech32.data
    } catch (e) {
      const base58 = bitcoin.address.fromBase58Check(address)
      return base58.hash
    }
  }

  getSwapOutput (recipientAddress, refundAddress, secretHash, nLockTime) {
    const recipientPubKeyHash = this.getPubKeyHash(recipientAddress)
    const refundPubKeyHash = this.getPubKeyHash(refundAddress)
    const OPS = bitcoin.script.OPS

    return bitcoin.script.compile([
      OPS.OP_IF,
      OPS.OP_SIZE,
      bitcoin.script.number.encode(32),
      OPS.OP_EQUALVERIFY,
      OPS.OP_SHA256,
      Buffer.from(secretHash, 'hex'),
      OPS.OP_EQUALVERIFY,
      OPS.OP_DUP,
      OPS.OP_HASH160,
      recipientPubKeyHash,
      OPS.OP_ELSE,
      bitcoin.script.number.encode(nLockTime),
      OPS.OP_CHECKLOCKTIMEVERIFY,
      OPS.OP_DROP,
      OPS.OP_DUP,
      OPS.OP_HASH160,
      refundPubKeyHash,
      OPS.OP_ENDIF,
      OPS.OP_EQUALVERIFY,
      OPS.OP_CHECKSIG
    ])
  }

  getSwapInput (sig, pubKey, isRedeem, secret) {
    const OPS = bitcoin.script.OPS
    const redeem = isRedeem ? OPS.OP_TRUE : OPS.OP_FALSE
    const secretParams = isRedeem ? [Buffer.from(secret, 'hex')] : []

    return bitcoin.script.compile([
      sig,
      pubKey,
      ...secretParams,
      redeem
    ])
  }

  getSwapPaymentVariants (swapOutput) {
    const p2wsh = bitcoin.payments.p2wsh({
      redeem: { output: swapOutput, network: this._network },
      network: this._network
    })
    const p2shSegwit = bitcoin.payments.p2sh({
      redeem: p2wsh, network: this._network
    })
    const p2sh = bitcoin.payments.p2sh({
      redeem: { output: swapOutput, network: this._network },
      network: this._network
    })

    return { p2wsh, p2shSegwit, p2sh }
  }

  async initiateSwap (value, recipientAddress, refundAddress, secretHash, expiration) {
    const swapOutput = this.getSwapOutput(recipientAddress, refundAddress, secretHash, expiration)
    const address = this.getSwapPaymentVariants(swapOutput)[this._mode].address
    return this.getMethod('sendTransaction')(address, value)
  }

  async claimSwap (initiationTxHash, recipientAddress, refundAddress, secret, expiration) {
    const secretHash = bitcoin.crypto.sha256(Buffer.from(secret, 'hex')).toString('hex')
    return this._redeemSwap(initiationTxHash, recipientAddress, refundAddress, expiration, true, secret, secretHash)
  }

  async refundSwap (initiationTxHash, recipientAddress, refundAddress, secretHash, expiration) {
    return this._redeemSwap(initiationTxHash, recipientAddress, refundAddress, expiration, false, undefined, secretHash)
  }

  async _redeemSwap (initiationTxHash, recipientAddress, refundAddress, expiration, isRedeem, secret, secretHash) {
    const network = this._network
    const address = isRedeem ? recipientAddress : refundAddress
    const swapOutput = this.getSwapOutput(recipientAddress, refundAddress, secretHash, expiration)
    const swapPaymentVariants = this.getSwapPaymentVariants(swapOutput)

    const initiationTxRaw = await this.getMethod('getRawTransactionByHash')(initiationTxHash)
    const initiationTx = await this.getMethod('getRawTransactionByHash')(initiationTxHash, true)

    let swapVout
    let paymentVariantName
    let paymentVariant
    for (const voutIndex in initiationTx._raw.vout) {
      const vout = initiationTx._raw.vout[voutIndex]
      const paymentVariantEntry = Object.entries(swapPaymentVariants).find(([, payment]) => payment.output.toString('hex') === vout.scriptPubKey.hex)
      if (paymentVariantEntry) {
        paymentVariantName = paymentVariantEntry[0]
        paymentVariant = paymentVariantEntry[1]
        swapVout = vout
      }
    }

    // TODO: Implement proper fee calculation that counts bytes in inputs and outputs
    // TODO: use node's feePerByte
    const txfee = calculateFee(1, 1, 3)

    swapVout.txid = initiationTxHash
    swapVout.vSat = swapVout.value * 1e8

    if (swapVout.vSat - txfee < 0) {
      throw new Error('Transaction amount does not cover fee.')
    }

    const txb = new bitcoin.TransactionBuilder(network)

    if (!isRedeem) txb.setLockTime(expiration)

    const prevOutScript = paymentVariant.output

    txb.addInput(swapVout.txid, swapVout.n, 0, prevOutScript)
    txb.addOutput(addressToString(address), swapVout.vSat - txfee)

    const tx = txb.buildIncomplete()

    const isSegwit = paymentVariantName === 'p2wsh' || paymentVariantName === 'p2shSegwit'

    const sig = await this.getMethod('signP2SHTransaction')(
      initiationTxRaw, // TODO: Why raw? can't it be a bitcoinjs-lib TX like the next one?
      tx,
      address,
      swapVout,
      isSegwit ? swapPaymentVariants.p2wsh.redeem.output : swapPaymentVariants.p2sh.redeem.output,
      isRedeem ? 0 : expiration,
      isSegwit
    )

    const walletAddress = await this.getMethod('getWalletAddress')(address)
    const swapInput = this.getSwapInput(sig, walletAddress.publicKey, isRedeem, secret)
    const paymentParams = { redeem: { output: swapOutput, input: swapInput, network }, network }
    const paymentWithInput = isSegwit
      ? bitcoin.payments.p2wsh(paymentParams)
      : bitcoin.payments.p2sh(paymentParams)

    if (isSegwit) {
      tx.setWitness(0, paymentWithInput.witness)
    }

    if (paymentVariantName === 'p2shSegwit') {
      // Adds the necessary push OP (PUSH34 (00 + witness script hash))
      const inputScript = bitcoin.script.compile([swapPaymentVariants.p2shSegwit.redeem.output])
      tx.setInputScript(0, inputScript)
    } else if (paymentVariantName === 'p2sh') {
      tx.setInputScript(0, paymentWithInput.input)
    }

    return this.getMethod('sendRawTransaction')(tx.toHex())
  }

  doesTransactionMatchSwapParams (transaction, value, recipientAddress, refundAddress, secretHash, expiration) {
    const swapOutput = this.getSwapOutput(recipientAddress, refundAddress, secretHash, expiration)
    const swapPaymentVariants = this.getSwapPaymentVariants(swapOutput)
    const vout = transaction._raw.vout.find(vout =>
      Object.values(swapPaymentVariants).find(payment =>
        payment.output.toString('hex') === vout.scriptPubKey.hex &&
        BigNumber(vout.value).times(1e8).eq(BigNumber(value))
      )
    )
    return Boolean(vout)
  }

  async verifyInitiateSwapTransaction (initiationTxHash, value, recipientAddress, refundAddress, secretHash, expiration) {
    const initiationTransaction = await this.getMethod('getTransactionByHash')(initiationTxHash)
    return this.doesTransactionMatchSwapParams(initiationTransaction, value, recipientAddress, refundAddress, secretHash, expiration)
  }

  async findSwapTransaction (recipientAddress, refundAddress, secretHash, expiration, startBlock, predicate) {
    let blockNumber = startBlock || await this.getMethod('getBlockHeight')() // TODO: Are mempool TXs possible?
    let swapTransaction = null
    let arrivedAtTip = false
    while (!swapTransaction) {
      let block
      try {
        block = await this.getMethod('getBlockByNumber')(blockNumber, true)
      } catch (e) {
        arrivedAtTip = true
      }
      if (block) {
        swapTransaction = block.transactions.find(predicate)
        blockNumber++
      }
      if (arrivedAtTip) {
        await sleep(5000)
      }
    }
    return swapTransaction
  }

  async findInitiateSwapTransaction (value, recipientAddress, refundAddress, secretHash, expiration, startBlock) {
    return this.findSwapTransaction(recipientAddress, refundAddress, secretHash, expiration, startBlock,
      tx => this.doesTransactionMatchSwapParams(tx, value, recipientAddress, refundAddress, secretHash, expiration)
    )
  }

  async findClaimSwapTransaction (initiationTxHash, recipientAddress, refundAddress, secretHash, expiration, startBlock) {
    const claimSwapTransaction = await this.findSwapTransaction(recipientAddress, refundAddress, secretHash, expiration, startBlock,
      tx => tx._raw.vout.find(vout => vout.scriptPubKey.addresses && vout.scriptPubKey.addresses.includes(recipientAddress))
    )

    return {
      ...claimSwapTransaction,
      secret: await this.getSwapSecret(claimSwapTransaction.hash)
    }
  }

  async findRefundSwapTransaction (initiationTxHash, recipientAddress, refundAddress, secretHash, expiration, startBlock) {
    const refundSwapTransaction = await this.findSwapTransaction(recipientAddress, refundAddress, secretHash, expiration, startBlock,
      tx => tx._raw.vout.find(vout => vout.scriptPubKey.addresses && vout.scriptPubKey.addresses.includes(refundAddress))
    )
    return refundSwapTransaction
  }

  async getSwapSecret (claimTxHash) {
    const claimTx = await this.getMethod('getTransactionByHash')(claimTxHash)
    const vin = claimTx._raw.vin[0]
    const inputScript = vin.txinwitness ? vin.txinwitness
      : bitcoin.script.decompile(Buffer.from(vin.scriptSig.hex, 'hex'))
        .map(b => Buffer.isBuffer(b) ? b.toString('hex') : b)
    return inputScript[2]
  }
}

BitcoinSwapProvider.version = version
