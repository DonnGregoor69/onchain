import { Contract, ContractTransaction, ethers, Signer } from 'ethers'
import { paths } from 'interfaces/apiTypes'
import setParams from './params'
import { WyvernV2 } from '@reservoir0x/sdk'
import { Interface } from 'ethers/lib/utils'

/**
 *
 * @param collectionContract
 * @param proxyRegistryContract
 * @param signer
 * @param tokenId
 * @returns The user proxy
 */
async function registerUserProxy(
  collectionContract: Contract,
  proxyRegistryContract: Contract,
  signer: Signer,
  tokenId: string
) {
  try {
    // Make sure the signer is the owner of the listed token
    const owner = await collectionContract.connect(signer).ownerOf(tokenId)

    const signerAddress = await signer.getAddress()

    if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
      console.error('Signer is not the token owner')
      return null
    }

    // Retrieve user proxy
    const userProxy = await proxyRegistryContract
      .connect(signer)
      .proxies(signerAddress)

    if (userProxy === ethers.constants.AddressZero) {
      // If the user has no associated proxy, then register one
      let { wait } = (await proxyRegistryContract
        .connect(signer)
        .registerProxy()) as ContractTransaction

      // Wait for the transaction to get mined
      await wait()

      // Retrieve user proxy
      const userProxy = await proxyRegistryContract
        .connect(signer)
        .proxies(signerAddress)

      return userProxy
    } else {
      // The user already registered a proxy
      return userProxy
    }
  } catch (error) {
    console.error('Could not check/register user proxy')
    return null
  }
}

// Check proxy aprroval
async function checkProxyApproval(
  collectionContract: Contract,
  signer: Signer,
  userProxy: any,
  tokenId: string
) {
  try {
    const signerAddress = await signer.getAddress()
    // Check approval on the user proxy
    let isApproved = await collectionContract
      .connect(signer)
      .isApprovedForAll(signerAddress, userProxy)

    if (!isApproved) {
      const approvedAddress = await collectionContract
        .connect(signer)
        .getApproved(tokenId)
      isApproved = approvedAddress.toLowerCase() === signerAddress.toLowerCase()
    }

    if (isApproved) {
      // Set success
      return true
    } else {
      // Set the approval on the user proxy
      const { wait } = (await collectionContract
        .connect(signer)
        .setApprovalForAll(userProxy, true)) as ContractTransaction

      // Wait for the transaction to get mined
      await wait()

      return true
    }
  } catch (error) {
    console.error('Could not check/set approval')
    return false
  }
}

async function getMatchingOrders(
  apiBase: string,
  chainId: number,
  signer: Signer,
  query: paths['/orders/fill']['get']['parameters']['query']
) {
  try {
    // Get the best offer for the token
    let url = new URL('/orders/fill', apiBase)

    setParams(url, query)

    // Get the best BUY order data
    let res = await fetch(url.href)

    let { order } =
      (await res.json()) as paths['/orders/fill']['get']['responses']['200']['schema']

    if (!order?.params) {
      throw 'API ERROR: Could not retrieve order params'
    }

    // Use SDK to create order object
    let buyOrder = new WyvernV2.Order(chainId, order?.params)

    // Instatiate an matching SELL Order
    let sellOrder = buyOrder.buildMatching(
      await signer.getAddress(),
      order.buildMatchingArgs
    )

    return { buyOrder, sellOrder }
  } catch (error) {
    console.error('Could not fill order', error)
    return null
  }
}

async function isProxyApproved(
  chainId: number,
  signer: Signer,
  tokenId: string,
  contract: string
) {
  const collectionContract = new Contract(
    contract,
    new Interface([
      'function ownerOf(uint256 tokenId) view returns (address)',
      'function getApproved(uint256 tokenId) view returns (address)',
      'function isApprovedForAll(address owner, address operator) view returns (bool)',
      'function setApprovalForAll(address operator, bool approved)',
    ])
  )

  const proxyRegistryContract = new Contract(
    chainId === 4
      ? '0xf57b2c51ded3a29e6891aba85459d600256cf317'
      : '0xa5409ec958c83c3f309868babaca7c86dcb077c1',
    new Interface([
      'function proxies(address) view returns (address)',
      'function registerProxy()',
    ])
  )

  try {
    const userProxy = await registerUserProxy(
      collectionContract,
      proxyRegistryContract,
      signer,
      tokenId
    )
    const proxyApproved = await checkProxyApproval(
      collectionContract,
      signer,
      userProxy,
      tokenId
    )
    return proxyApproved
  } catch (error) {
    console.error('Could not fill order', error)
    return false
  }
}

/**
 *
 * @param apiBase The Reservoir API base url
 * @param chainId The Ethereum chain ID (eg: 1 - Ethereum Mainnet, 4 - Rinkeby Testnet)
 * @param signer An Ethereum signer object
 * @param contract The contract address for the collection
 * @param tokenId The token ID
 * @returns `true` if the transaction was succesful, `fasle` otherwise
 */
async function acceptOffer(
  apiBase: string,
  chainId: number,
  signer: Signer | undefined,
  query: paths['/orders/fill']['get']['parameters']['query']
) {
  if (!signer || !query.contract) {
    console.debug({ signer, query })
    throw 'some data is undefined'
  }

  try {
    const proxyApproved = await isProxyApproved(
      chainId,
      signer,
      query.tokenId,
      query.contract
    )

    if (proxyApproved) {
      const orders = await getMatchingOrders(apiBase, chainId, signer, query)
      if (orders) {
        const { buyOrder, sellOrder } = orders
        // Instantiate WyvernV2 Exchange contract object
        const exchange = new WyvernV2.Exchange(chainId)

        // Execute token sell
        let { wait } = await exchange.match(signer, buyOrder, sellOrder)

        // Wait for transaction to be mined
        await wait()

        return true
      }
      return false
    }
    return false
  } catch (error) {
    console.error('Could not fill order', error)
    return false
  }
}

async function listTokenForSell(
  apiBase: string,
  chainId: number,
  signer: Signer | undefined,
  query: paths['/orders/build']['get']['parameters']['query']
) {
  if (!signer || !query.tokenId || !query.contract) {
    console.debug({ signer, query })
    return
  }

  try {
    const proxyApproved = await isProxyApproved(
      chainId,
      signer,
      query.tokenId,
      query.contract
    )

    if (proxyApproved) {
      // Build a selling order
      let url = new URL('/orders/build', apiBase)

      setParams(url, query)

      let res = await fetch(url.href)

      let { order } =
        (await res.json()) as paths['/orders/build']['get']['responses']['200']['schema']

      if (!order?.params) {
        throw 'API ERROR: Could not retrieve order params'
      }

      // Use SDK to create order object
      const sellOrder = new WyvernV2.Order(chainId, order.params)

      // Sign selling order
      await sellOrder.sign(signer)

      // Post order to the database
      let url2 = new URL('/orders', apiBase)

      await fetch(url2.href, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          orders: [
            {
              kind: 'wyvern-v2',
              data: sellOrder.params,
            },
          ],
        }),
      })

      return true
    }

    return false
  } catch (error) {
    console.error(error)
    return false
  }
}

export {
  registerUserProxy,
  checkProxyApproval,
  getMatchingOrders,
  acceptOffer,
  listTokenForSell,
}