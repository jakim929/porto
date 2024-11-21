import type * as Address from 'ox/Address'
import { http, type Client, type Transport, createClient } from 'viem'
import { persist, subscribeWithSelector } from 'zustand/middleware'
import { type Mutate, type StoreApi, createStore } from 'zustand/vanilla'

import * as Chains from './Chains.js'
import * as AccountDelegation from './internal/accountDelegation.js'
import * as Provider from './internal/provider.js'
import * as Storage from './internal/storage.js'
import * as WebAuthn from './internal/webauthn.js'

export const defaultConfig = {
  announceProvider: true,
  chains: [Chains.odysseyTestnet],
  headless: true,
  keystoreHost: 'exp.porto.sh',
  transports: {
    [Chains.odysseyTestnet.id]: http(),
  },
} as const satisfies Config

/**
 * Instantiates an Porto instance.
 *
 * @example
 * ```ts twoslash
 * import { Porto } from 'porto'
 *
 * const porto = Porto.create()
 *
 * const blockNumber = await porto.provider.request({ method: 'eth_blockNumber' })
 * ```
 */
export function create<
  chains extends readonly [
    Chains.Chain,
    ...Chains.Chain[],
  ] = typeof defaultConfig.chains,
>(config?: Config<chains>): Porto<chains>
export function create(config?: Config | undefined): Porto {
  const {
    announceProvider = defaultConfig.announceProvider,
    chains = defaultConfig.chains,
    headless = defaultConfig.headless,
    transports = defaultConfig.transports,
  } = config ?? {}

  const keystoreHost = (() => {
    if (config?.keystoreHost === 'self') return undefined
    if (config?.keystoreHost) return config.keystoreHost
    if (
      typeof window !== 'undefined' &&
      window.location.hostname === 'localhost'
    )
      return undefined
    return defaultConfig.keystoreHost
  })()

  if (headless && keystoreHost) WebAuthn.touchWellknown({ rpId: keystoreHost })

  const store = createStore(
    subscribeWithSelector(
      persist<State>(
        (_, get) => ({
          accounts: [],
          chain: chains[0],

          // computed
          get chainId() {
            const { chain } = get()
            return chain.id
          },
          get client() {
            const { chain } = get()
            return createClient({
              chain,
              transport: (transports as Record<number, Transport>)[chain.id]!,
            })
          },
          get delegation() {
            const { chain } = get()
            return chain.contracts.accountDelegation.address
          },
        }),
        {
          name: 'porto.store',
          merge,
          partialize(state) {
            return {
              accounts: state.accounts.map((account) => ({
                ...account,
                keys: account.keys.map((key) => ({
                  ...key,
                  ...('raw' in key
                    ? {
                        raw: undefined,
                      }
                    : {}),
                })),
              })),
              chain: state.chain,
            } as State
          },
          storage: Storage.idb,
        },
      ),
    ),
  )
  store.persist.rehydrate()

  const provider = Provider.from({
    config: {
      announceProvider,
      chains,
      headless,
      keystoreHost,
      transports,
    } as Config,
    store,
  })

  return {
    destroy() {
      provider._internal.destroy()
    },
    provider,
    _internal: {
      store,
    },
  }
}

export type Porto<
  chains extends readonly [Chains.Chain, ...Chains.Chain[]] = readonly [
    Chains.Chain,
    ...Chains.Chain[],
  ],
> = {
  destroy: () => void
  provider: Provider.Provider
  /**
   * Not part of versioned API, proceed with caution.
   * @deprecated
   */
  _internal: {
    store: StoreApi<State<chains>>
  }
}

export type Config<
  chains extends readonly [Chains.Chain, ...Chains.Chain[]] = readonly [
    Chains.Chain,
    ...Chains.Chain[],
  ],
> = {
  /**
   * Whether to announce the provider via EIP-6963.
   * @default true
   */
  announceProvider?: boolean | undefined
  /**
   * List of supported chains.
   */
  chains?: chains | readonly [Chains.Chain, ...Chains.Chain[]]
  /**
   * Whether to run EIP-1193 Provider in headless mode.
   * @default true
   */
  headless?: boolean | undefined
  /**
   * Keystore host (WebAuthn relying party).
   * @default 'self'
   */
  keystoreHost?: 'self' | (string & {}) | undefined
  /**
   * Transport to use for each chain.
   */
  transports?: Record<chains[number]['id'], Transport>
}

export type State<
  chains extends readonly [Chains.Chain, ...Chains.Chain[]] = readonly [
    Chains.Chain,
    ...Chains.Chain[],
  ],
> = {
  accounts: AccountDelegation.Account[]
  chain: chains[number]
  readonly chainId: chains[number]['id']
  readonly client: Client<
    Transport,
    Extract<chains[number], { id: chains[number]['id'] }>
  >
  readonly delegation: Address.Address
}

export type Store<
  chains extends readonly [Chains.Chain, ...Chains.Chain[]] = readonly [
    Chains.Chain,
    ...Chains.Chain[],
  ],
> = Mutate<
  StoreApi<State<chains>>,
  [['zustand/subscribeWithSelector', never], ['zustand/persist', any]]
>

function merge(p: unknown, currentState: State): State {
  const persistedState = p as State
  const state = { ...currentState, ...persistedState }
  return {
    ...state,
    accounts: state.accounts.map((account) => ({
      ...account,
      keys: account.keys.filter(
        (key) => key.expiry === 0n || AccountDelegation.isActiveSessionKey(key),
      ),
    })),
  } satisfies State
}