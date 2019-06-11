pragma solidity ^0.4.24;

import "./lib/ERC20.sol";
import "./lib/Escapable.sol";
import "./FundsForwarderFactory.sol";

interface IGivethBridge {
    function donateAndCreateGiver(address giver, uint64 receiverId) external payable;
    function donateAndCreateGiver(address giver, uint64 receiverId, address token, uint _amount) external payable;
    function donate(uint64 giverId, uint64 receiverId) external payable;
    function donate(uint64 giverId, uint64 receiverId, address token, uint _amount) external payable;
}


contract FundsForwarder is Escapable {
    uint64 public receiverId;
    address public giverId;
    FundsForwarderFactory public fundsForwarderFactory;

    string private constant ERROR_ERC20_APPROVE = "ERROR_ERC20_APPROVE";
    string private constant ERROR_BRIDGE_CALL = "ERROR_BRIDGE_CALL";

    event Forwarded(address to, address token, uint balance, bool result);

    /**
    * @param _bridgeGetterAddress Contract address to get the bridge address from
    * @param _giverId The adminId of the liquidPledging pledge admin who is donating
    * @param _receiverId The adminId of the liquidPledging pledge admin receiving the donation
    * @param _escapeHatchCaller The address of a trusted account or contract to
    *  call `escapeHatch()` to send the ether in this contract to the
    *  `escapeHatchDestination` it would be ideal if `escapeHatchCaller` cannot move
    *  funds out of `escapeHatchDestination`
    * @param _escapeHatchDestination The address of a safe location (usu a
    *  Multisig) to send the ether held in this contract in an emergency
    */
    constructor(
        address _bridgeGetterAddress,
        uint64 _giverId,
        uint64 _receiverId,
        address _escapeHatchCaller,
        address _escapeHatchDestination
    ) Escapable(_escapeHatchCaller, _escapeHatchDestination) public {
        fundsForwarderFactory = FundsForwarderFactory(_bridgeGetterAddress);
        receiverId = _receiverId;
        giverId = _giverId;
    }

    /**
    * Fallback function to receive ETH donations
    */
    function() public payable {}

    /**
    * Transfer tokens/eth to the bridge. Transfer the entire balance of the contract
    * @param _token the token to transfer. 0x0 for ETH
    */
    function forward(address _token) external {
        IGivethBridge bridge = IGivethBridge(fundsForwarderFactory.bridge());
        uint balance;
        bool result;
        /// @dev Logic for ether
        if (_token == 0) {
            balance = address(this).balance;
            /// @dev Call donate() with two arguments, for tokens
            /// Low level .call must be used due to function overloading
            result = address(bridge).call.value(balance)(
                0xbde60ac9,
                giverId,
                receiverId
            );
        /// @dev Logic for tokens
        } else {
            ERC20 token = ERC20(_token);
            balance = token.balanceOf(this);
            require(token.approve(bridge, balance), ERROR_ERC20_APPROVE);
            /// @dev Call donate() with four arguments, for tokens
            /// Low level .call must be used due to function overloading
            result = address(bridge).call(
                0x4c4316c7,
                giverId,
                receiverId,
                token,
                balance
            );
        }
        require(result, ERROR_BRIDGE_CALL);
        emit Forwarded(bridge, _token, balance, result);
    }
}