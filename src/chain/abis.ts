/**
 * Minimal ABIs for the Reppo contract surface the CLI touches. Mainnet uses
 * the V1 PodManager (`mintPod(to, emissionShare)`); testnet uses the V2
 * PodManager (`mintPodWithREPPO(to, subnetId)`). Voting + ve-token + subnet
 * access ABIs are shared.
 */
import { parseAbi } from 'viem';

export const POD_MANAGER_MAINNET_ABI = parseAbi([
  'function mintPod(address to, uint8 emissionSharePercent) returns (uint256 podId)',
  'function publishingFee() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function vote(uint256 podId, uint256 subnetId, bool like_)',
  'function claimPodOwnerEmissions(uint256 podId, uint256 epoch)',
  'function getPodEmissionsOfEpoch(uint256 epoch, uint256 podId) view returns (uint256)',
  'function hasPodOwnerClaimedEmissions(uint256 epoch, uint256 podId) view returns (bool)',
  'function getEpochTotalVotes(uint256 epoch) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

export const POD_MANAGER_TESTNET_ABI = parseAbi([
  'function mintPodWithREPPO(address to, uint256 subnetId) returns (uint256 podId)',
  'function mintPodWithPrimaryToken(address to, uint256 subnetId) returns (uint256 podId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function vote(uint256 podId, uint256 subnetId, bool like_)',
  'function claimPodOwnerEmissions(uint256 podId, uint256 epoch)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

export const SUBNET_MANAGER_ABI = parseAbi([
  'function accessSubnetWithREPPOFee(uint256 subnetId, address to)',
  'function hasSubnetAccess(uint256 subnetId, address address_) view returns (bool)',
  'function validSubnet(uint256 subnetId) view returns (bool)',
  'function getAccessFeeREPPO(uint256 subnetId) view returns (uint256)',
]);

export const VE_REPPO_ABI = parseAbi([
  'function votingPowerOf(address) view returns (uint256)',
  'function stake(uint256 amount, uint256 duration) returns (uint256 lockupId)',
  'function stakeMore(uint256 lockupId, uint256 amount)',
  'function extendLock(uint256 lockupId, uint256 duration)',
  'function previewPoints(uint256 amount, uint256 duration) view returns (uint256)',
  'function minStakeDuration() view returns (uint256)',
  'function maxStakeDuration() view returns (uint256)',
  'function lockupData(uint256 lockupId) view returns (uint256 amount, uint256 expiresAt, uint256 unused, uint256 votingPower)',
  'function balanceOf(address) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);

export const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const UNISWAP_ROUTER_ABI = parseAbi([
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
  'function multicall(uint256 deadline, bytes[] calldata data) payable returns (bytes[] memory results)',
]);

export const QUOTER_ABI = parseAbi([
  'function quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amount, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountIn, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);
