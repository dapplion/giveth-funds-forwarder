# Giveth Funds Forwarder

Intermediate contract to allow donations from DAOs or other contracts to Giveth milestones via its bridge.

```
                  Funds Forwarder Factory
                            ||
                            || deploy(receiverId)
                            \/
DAO ======> Funds Forwarder ======> Bridge ======> Milestone
    send ETH           forward(receiverId)
  transfer Token
```

The `FundsForwarder` is meant to be a proxy deployed by its factory `FundsForwarderFactory`. The current implementation uses [EIP 1167](https://github.com/ethereum/EIPs/blob/master/EIPS/eip-1167.md), a technique to deploy forwarding proxies (not upgradable) at very low gas costs. The `FundsForwarder` incorporates the [Initializable](https://hack.aragon.org/docs/common_Initializable) and [Petrifiable](https://hack.aragon.org/docs/common_Petrifiable) scheme used by [Aragon](https://github.com/aragon/aragonOS) to freeze the original logic contract and control proxy initialization. The initialization is done atomically in one transaction by the `FundsForwarderFactory`. The `FundsForwarder` contract also incorporates functionality from the Escapable contract by Jordi Baylina and Adrià Massanet to allow recovery of funds as a last resort if a security issue is uncovered.

### Gas costs

| Action                       | Gas cost  | Gas cost (without proxy) | Frequency                                    |
| ---------------------------- | --------- | ------------------------ | -------------------------------------------- |
| Deploy FundsForwarderFactory | 2,087,308 | -                        | Once                                         |
| Deploy FundsForwarder logic  | 1,392,086 | -                        | Once                                         |
| Deploy FundForwarder         | 117,207   | 1,661,250 (+1,317%)      | Once for each applicable milestone           |
| Forward ETH to bridge        | 39,291    | 38,500 (-2%)             | Every time each milestone requires the funds |
| Forward Tokens to bridge     | 67,300    | 66,509 (-1%)             | Every time each milestone requires the funds |
