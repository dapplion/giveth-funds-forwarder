pragma solidity 0.4.24;

import "./FundsForwarder.sol";
import "./lib/IsContract.sol";
import "./lib/Escapable.sol";


contract FundsForwarderFactory is Escapable, IsContract {
    address public bridge;
    address public childImplementation;

    string private constant ERROR_NOT_A_CONTRACT = "ERROR_NOT_A_CONTRACT";
    string private constant ERROR_HATCH_CALLER = "ERROR_HATCH_CALLER";
    string private constant ERROR_HATCH_DESTINATION = "ERROR_HATCH_DESTINATION";

    event NewFundForwarder(address indexed _giver, uint64 indexed _receiverId, address fundsForwarder);
    event BridgeChanged(address newBridge);
    event ChildImplementationChanged(address newChildImplementation);

    /**
    * @notice Create a new factory for deploying Giveth FundForwarders
    * @dev Requires a deployed bridge
    * @param _bridge Bridge address
    * @param _escapeHatchCaller The address of a trusted account or contract to
    *  call `escapeHatch()` to send the ether in this contract to the
    *  `escapeHatchDestination` it would be ideal if `escapeHatchCaller` cannot move
    *  funds out of `escapeHatchDestination`
    * @param _escapeHatchDestination The address of a safe location (usually a
    *  Multisig) to send the value held in this contract in an emergency
    */
    constructor(
        address _bridge,
        address _escapeHatchCaller,
        address _escapeHatchDestination
    ) Escapable(_escapeHatchCaller, _escapeHatchDestination) public {
        require(isContract(_bridge), ERROR_NOT_A_CONTRACT);
        bridge = _bridge;

        // Set the escapeHatch params to the same as in the bridge
        Escapable bridgeInstance = Escapable(_bridge);
        require(_escapeHatchCaller == bridgeInstance.escapeHatchCaller(), ERROR_HATCH_CALLER);
        require(_escapeHatchDestination == bridgeInstance.escapeHatchDestination(), ERROR_HATCH_DESTINATION);
    }

    /**
    * @notice Change the bridge address.
    * @param _bridge New bridge address
    */
    function changeBridge(address _bridge) external onlyEscapeHatchCallerOrOwner {
        bridge = _bridge;
        emit BridgeChanged(_bridge);
    }

    /**
    * @notice Change the childImplementation address.
    * @param _childImplementation New childImplementation address
    */
    function changeChildImplementation(address _childImplementation) external onlyEscapeHatchCallerOrOwner {
        childImplementation = _childImplementation;
        emit ChildImplementationChanged(_childImplementation);
    }

    /**
    * @param _giverId The adminId of the liquidPledging pledge admin who is donating
    * @param _receiverId The adminId of the liquidPledging pledge admin receiving the donation
    */
    function newFundsForwarder(uint64 _giverId, uint64 _receiverId) public {
        address fundsForwarder = _deployMinimal(childImplementation);
        FundsForwarder(fundsForwarder).initialize(address(this), _giverId, _receiverId);

        // Store a registry of fundForwarders as events
        emit NewFundForwarder(_giverId, _receiverId, fundsForwarder);
    }

    /**
     * @notice Deploys a minimal forwarding proxy that is not upgradable
     * From ZepelinOS https://github.com/zeppelinos/zos/blob/v2.4.0/packages/lib/contracts/upgradeability/ProxyFactory.sol
     */
    function _deployMinimal(address _logic) internal returns (address proxy) {
        // Adapted from https://github.com/optionality/clone-factory/blob/32782f82dfc5a00d103a7e61a17a5dedbd1e8e9d/contracts/CloneFactory.sol
        bytes20 targetBytes = bytes20(_logic);
        assembly {
            let clone := mload(0x40)
            mstore(clone, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(clone, 0x14), targetBytes)
            mstore(add(clone, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            proxy := create(0, clone, 0x37)
        }
    }
}