pragma solidity 0.4.24;

import "./FundsForwarder.sol";
import "./lib/IsContract.sol";
import "./lib/Escapable.sol";


contract FundsForwarderFactory is Escapable, IsContract {
    address public bridge;
    address public escapeHatchCaller;
    address public escapeHatchDestination;

    mapping (uint64 => address) public fundsForwarders;

    event NewFundForwarder(address indexed _giver, uint64 indexed _receiverId, address fundsForwarder);

    /**
    * @notice Create a new factory for deploying Giveth FundForwarders
    * @dev Requires a deployed bridge
    * @param _bridge Base factory for deploying DAOs
    * @param _escapeHatchCaller The address of a trusted account or contract to
    *  call `escapeHatch()` to send the ether in this contract to the
    *  `escapeHatchDestination` it would be ideal if `escapeHatchCaller` cannot move
    *  funds out of `escapeHatchDestination`
    * @param _escapeHatchDestination The address of a safe location (usu a
    *  Multisig) to send the ether held in this contract in an emergency
    */
    constructor(
        address _bridge,
        address _escapeHatchCaller,
        address _escapeHatchDestination
    ) Escapable(_escapeHatchCaller, _escapeHatchDestination) public {
        require(isContract(_bridge), "MUST BE CONTRACT");
        bridge = _bridge;

        // Set the escapeHatch params to the same as in the bridge
        Escapable bridgeInstance = Escapable(_bridge);
        require(_escapeHatchCaller == bridgeInstance.escapeHatchCaller(), "WRONG escapeHatchCaller");
        require(_escapeHatchDestination == bridgeInstance.escapeHatchDestination(), "WRONG escapeHatchDestination");
    }

    /**
    * @notice Change the bridge address.
    * @param _bridge New bridge address
    */
    function changeBridge(address _bridge) external onlyEscapeHatchCallerOrOwner {
        bridge = _bridge;
    }

    /**
    * @param _giverId The adminId of the liquidPledging pledge admin who is donating
    * @param _receiverId The adminId of the liquidPledging pledge admin receiving the donation
    */
    function newFundsForwarder(uint64 _giverId, uint64 _receiverId) public {
        address fundsForwarder = new FundsForwarder(
            address(this),
            _giverId,
            _receiverId,
            escapeHatchCaller,
            escapeHatchDestination
        );
        fundsForwarders[_receiverId] = fundsForwarder;

        // Set the owner of the fundForwarder to this contract's owner
        Owned(fundsForwarder).changeOwnership(owner);

        // Store a registry of fundForwarders as events
        emit NewFundForwarder(_giverId, _receiverId, fundsForwarder);
    }
}