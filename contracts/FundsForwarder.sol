pragma solidity ^0.4.24;

import "./lib/ERC20.sol";
import "./lib/Escapable.sol";
import "./lib/Initializable.sol";
import "./lib/Autopetrified.sol";
import "./FundsForwarderFactory.sol";

interface IGivethBridge {
    function donate(uint64 giverId, uint64 receiverId) external payable;
    function donate(uint64 giverId, uint64 receiverId, address token, uint _amount) external payable;
}


contract FundsForwarder {
    uint64 public receiverId;
    uint64 public giverId;
    FundsForwarderFactory public fundsForwarderFactory;

    string private constant ERROR_ERC20_APPROVE = "ERROR_ERC20_APPROVE";
    string private constant ERROR_BRIDGE_CALL = "ERROR_BRIDGE_CALL";
    string private constant ERROR_DISALLOWED = "RECOVER_DISALLOWED";
    string private constant ERROR_TOKEN_TRANSFER = "RECOVER_TOKEN_TRANSFER";
    string private constant ERROR_ALREADY_INITIALIZED = "INIT_ALREADY_INITIALIZED";
    uint private constant MAX_UINT = uint(-1);

    event Forwarded(address to, address token, uint balance, bool result);
    event EscapeHatchCalled(address token, uint amount);

    constructor() public {
        /// @dev From AragonOS's Autopetrified contract
        // Immediately petrify base (non-proxy) instances of inherited contracts on deploy.
        // This renders them uninitializable (and unusable without a proxy).
        fundsForwarderFactory = FundsForwarderFactory(address(-1));
    }

    /**
    * Fallback function to receive ETH donations
    */
    function() public payable {}

    /**
    * @dev Initialize can only be called once.
    * @notice msg.sender MUST be the _fundsForwarderFactory Contract
    *  Its address must be a contract with three public getters:
    *  - bridge(): Returns the bridge address
    *  - escapeHatchCaller(): Returns the escapeHatchCaller address
    *  - escapeHatchDestination(): Returns the escashouldpeHatchDestination address
    * @param _giverId The adminId of the liquidPledging pledge admin who is donating
    * @param _receiverId The adminId of the liquidPledging pledge admin receiving the donation
    */
    function initialize(uint64 _giverId, uint64 _receiverId) public {
        /// @dev onlyInit method from AragonOS's Initializable contract
        require(fundsForwarderFactory == address(0), ERROR_ALREADY_INITIALIZED);
        /// @dev Setting fundsForwarderFactory, serves as calling initialized()
        fundsForwarderFactory = FundsForwarderFactory(msg.sender);
        /// @dev Make sure that the fundsForwarderFactory is a contact and has a bridge method
        require(fundsForwarderFactory.bridge() != address(0), ERROR_BRIDGE_CALL);

        receiverId = _receiverId;
        giverId = _giverId;
    }

    /**
    * Transfer tokens/eth to the bridge. Transfer the entire balance of the contract
    * @param _token the token to transfer. 0x0 for ETH
    */
    function forward(address _token) public {
        IGivethBridge bridge = IGivethBridge(fundsForwarderFactory.bridge());
        uint balance;
        bool result;
        /// @dev Logic for ether
        if (_token == address(0)) {
            balance = address(this).balance;
            /// @dev Call donate() with two arguments, for tokens
            /// Low level .call must be used due to function overloading
            /* solium-disable-next-line security/no-call-value */
            result = address(bridge).call.value(balance)(
                0xbde60ac9,
                giverId,
                receiverId
            );
        /// @dev Logic for tokens
        } else {
            ERC20 token = ERC20(_token);
            balance = token.balanceOf(this);
            /// @dev Since the bridge is a trusted contract, the max allowance
            ///  will be set on the first token transfer. Then it's skipped
            ///  Numbers for DAI        First tx | n+1 txs
            ///  approve(_, balance)      66356     51356
            ///  approve(_, MAX_UINT)     78596     39103
            ///                          +12240    -12253
            ///  Worth it if forward is called more than once for each token
            if (token.allowance(address(this), bridge) < balance) {
                require(token.approve(bridge, MAX_UINT), ERROR_ERC20_APPROVE);
            }

            /// @dev Call donate() with four arguments, for tokens
            /// Low level .call must be used due to function overloading
            /* solium-disable-next-line security/no-low-level-calls */
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

    /**
    * Transfer multiple tokens/eth to the bridge. Simplies UI interactions
    * @param _tokens the array of tokens to transfer. 0x0 for ETH
    */
    function forwardMultiple(address[] _tokens) public {
        uint tokensLength = _tokens.length;
        for (uint i = 0; i < tokensLength; i++) {
            forward(_tokens[i]);
        }
    }

    /**
    * @notice Send funds to recovery address (escapeHatchDestination).
    * The `escapeHatch()` should only be called as a last resort if a
    * security issue is uncovered or something unexpected happened
    * @param _token Token balance to be sent to recovery vault.
    *
    * @dev Only the escapeHatchCaller can trigger this function
    * @dev The escapeHatchCaller address must not have control over escapeHatchDestination
    * @dev Function extracted from the Escapable contract (by Jordi Baylina and Adrià Massanet)
    * Instead of storing the caller, destination and owner addresses,
    * it fetches them from the parent contract.
    */
    function escapeHatch(address _token) public {
        /// @dev Serves as the original contract's onlyEscapeHatchCaller
        require(msg.sender == fundsForwarderFactory.escapeHatchCaller(), ERROR_DISALLOWED);

        address escapeHatchDestination = fundsForwarderFactory.escapeHatchDestination();

        uint256 balance;
        if (_token == 0x0) {
            balance = address(this).balance;
            escapeHatchDestination.transfer(balance);
        } else {
            ERC20 token = ERC20(_token);
            balance = token.balanceOf(this);
            require(token.transfer(escapeHatchDestination, balance), ERROR_TOKEN_TRANSFER);
        }

        emit EscapeHatchCalled(_token, balance);
    }
}