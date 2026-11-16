import { atom } from 'nanostores'
export const $connection = atom('open')
export const $connectionEpoch = atom(1)
export const $gatewayReady = atom(null)
export const gatewayRequest = (method: string, params?: unknown) => (window as any).fixtureGateway(method, params)
export const onGatewayEvent = () => () => {}
export const onAnyGatewayEvent = () => () => {}
export const onServerRequest = () => () => {}
export const bindGatewayToBackend = () => () => {}
export const isGatewayOpen = () => true
