import { Fixture } from 'ethereum-waffle'
import { constants } from 'ethers'
import { ethers, waffle } from 'hardhat'

import UniswapV3FactoryJson from '@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json'
import NFTDescriptor from '@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json'
import MockTimeNonfungiblePositionManager from '@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json'
import NonfungibleTokenPositionDescriptor from '@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json'
import SwapRouter from '@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json'
import { IUniswapV3Factory } from '../../typechain'
import WETH9 from '../contracts/WETH9.json'
import { linkLibraries } from './linkLibraries'
import { INonfungiblePositionManager } from '../../typechain'
import { TestERC20 } from '../../typechain'
import { UniswapV3Staker } from '../../typechain'
import { FeeAmount, BigNumber, encodePriceSqrt } from '../shared'

type IWETH9 = any
type MockTimeSwapRouter = any
type WETH9Fixture = { weth9: IWETH9 }

export const wethFixture: Fixture<WETH9Fixture> = async (
  [wallet],
  provider
) => {
  const weth9 = (await waffle.deployContract(wallet, {
    bytecode: WETH9.bytecode,
    abi: WETH9.abi,
  })) as IWETH9

  return { weth9 }
}

const v3CoreFactoryFixture: Fixture<IUniswapV3Factory> = async ([wallet]) => {
  return ((await waffle.deployContract(wallet, {
    bytecode: UniswapV3FactoryJson.bytecode,
    abi: UniswapV3FactoryJson.abi,
  })) as unknown) as IUniswapV3Factory
}

export const v3RouterFixture: Fixture<{
  weth9: IWETH9
  factory: IUniswapV3Factory
  router: MockTimeSwapRouter
}> = async ([wallet], provider) => {
  const { weth9 } = await wethFixture([wallet], provider)
  const factory = await v3CoreFactoryFixture([wallet], provider)
  const router = ((await waffle.deployContract(
    wallet,
    {
      bytecode: SwapRouter.bytecode,
      abi: SwapRouter.abi,
    },
    [factory.address, weth9.address]
  )) as unknown) as any

  return { factory, weth9, router }
}

type MockTimeNonfungiblePositionManager = any

type NFTDescriptorLibrary = any
const nftDescriptorLibraryFixture: Fixture<NFTDescriptorLibrary> = async ([
  wallet,
]) => {
  return await waffle.deployContract(wallet, {
    bytecode: NFTDescriptor.bytecode,
    abi: NFTDescriptor.abi,
  })
}

type UniswapFactoryFixture = {
  weth9: IWETH9
  factory: IUniswapV3Factory
  router: MockTimeSwapRouter
  nft: MockTimeNonfungiblePositionManager
  tokens: [TestERC20, TestERC20, TestERC20]
}

export const uniswapFactoryFixture: Fixture<UniswapFactoryFixture> = async (
  wallets,
  provider
) => {
  const { weth9, factory, router } = await v3RouterFixture(wallets, provider)
  const tokenFactory = await ethers.getContractFactory('TestERC20')
  const tokens = (await Promise.all([
    tokenFactory.deploy(constants.MaxUint256.div(2)), // do not use maxu256 to avoid overflowing
    tokenFactory.deploy(constants.MaxUint256.div(2)),
    tokenFactory.deploy(constants.MaxUint256.div(2)),
  ])) as [TestERC20, TestERC20, TestERC20]

  const nftDescriptorLibrary = await nftDescriptorLibraryFixture(
    wallets,
    provider
  )

  const linkedBytecode = linkLibraries(
    {
      bytecode: NonfungibleTokenPositionDescriptor.bytecode,
      linkReferences: {
        'NFTDescriptor.sol': {
          NFTDescriptor: [
            {
              length: 20,
              start: 1261,
            },
          ],
        },
      },
    },
    {
      NFTDescriptor: nftDescriptorLibrary.address,
    }
  )

  const positionDescriptor = await waffle.deployContract(
    wallets[0],
    {
      bytecode: linkedBytecode,
      abi: NonfungibleTokenPositionDescriptor.abi,
    },
    [tokens[0].address]
  )

  const nft = await waffle.deployContract(
    wallets[0],
    {
      bytecode: MockTimeNonfungiblePositionManager.bytecode,
      abi: MockTimeNonfungiblePositionManager.abi,
    },
    [factory.address, weth9.address, positionDescriptor.address]
  )

  tokens.sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1
  )

  return {
    weth9,
    factory,
    router,
    tokens,
    nft,
  }
}

export const mintPosition = async (
  nft: INonfungiblePositionManager,
  mintParams: {
    token0: string
    token1: string
    fee: FeeAmount
    tickLower: number
    tickUpper: number
    recipient: string
    amount0Desired: any
    amount1Desired: any
    amount0Min: number
    amount1Min: number
    deadline: number
  }
): Promise<string> => {
  const transferFilter = nft.filters.Transfer(null, null, null)
  const transferTopic = nft.interface.getEventTopic('Transfer')

  let tokenId: BigNumber | undefined

  const receipt = await (
    await nft.mint({
      token0: mintParams.token0,
      token1: mintParams.token1,
      fee: mintParams.fee,
      tickLower: mintParams.tickLower,
      tickUpper: mintParams.tickUpper,
      recipient: mintParams.recipient,
      amount0Desired: mintParams.amount0Desired,
      amount1Desired: mintParams.amount1Desired,
      amount0Min: mintParams.amount0Min,
      amount1Min: mintParams.amount1Min,
      deadline: mintParams.deadline,
    })
  ).wait()

  for (let i = 0; i < receipt.logs.length; i++) {
    const log = receipt.logs[i]
    if (log.address === nft.address && log.topics.includes(transferTopic)) {
      // for some reason log.data is 0x so this hack just re-fetches it
      const events = await nft.queryFilter(transferFilter, log.blockHash)
      if (events.length === 1) {
        tokenId = events[0].args?.tokenId
      }
      break
    }
  }

  if (tokenId === undefined) {
    throw 'could not find tokenId after mint'
  } else {
    return tokenId.toString()
  }
}

export const uniswapFixture: Fixture<{
  nft: INonfungiblePositionManager
  factory: IUniswapV3Factory
  staker: UniswapV3Staker
  tokens: [TestERC20, TestERC20, TestERC20]
  pool01: string
  pool12: string
}> = async (wallets, provider) => {
  const { tokens, nft, factory } = await uniswapFactoryFixture(
    wallets,
    provider
  )
  const stakerFactory = await ethers.getContractFactory('UniswapV3Staker')
  const staker = (await stakerFactory.deploy(
    factory.address,
    nft.address
  )) as UniswapV3Staker

  for (const token of tokens) {
    await token.approve(nft.address, constants.MaxUint256)
  }

  await nft.createAndInitializePoolIfNecessary(
    tokens[0].address,
    tokens[1].address,
    FeeAmount.MEDIUM,
    encodePriceSqrt(1, 1)
  )

  await nft.createAndInitializePoolIfNecessary(
    tokens[1].address,
    tokens[2].address,
    FeeAmount.MEDIUM,
    encodePriceSqrt(1, 1)
  )

  const pool01 = await factory.getPool(
    tokens[0].address,
    tokens[1].address,
    FeeAmount.MEDIUM
  )

  const pool12 = await factory.getPool(
    tokens[1].address,
    tokens[2].address,
    FeeAmount.MEDIUM
  )

  return { nft, tokens, staker, factory, pool01, pool12 }
}
