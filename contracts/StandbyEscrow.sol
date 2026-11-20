// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice One prepaid booking. On Arc, native value and gas are both test USDC.
contract StandbyEscrow {
    uint256 public constant HOLD_FEE = 0.15 ether;
    uint256 public constant BALANCE_DUE = 0.75 ether;
    uint256 public constant TOTAL = HOLD_FEE + BALANCE_DUE;
    address public immutable organizer;
    address payable public immutable venue;
    uint64 public immutable cutoff;

    enum Status { Unfunded, Funded, Held, Confirmed, Expired }
    Status public status;

    error Unauthorized();
    error InvalidTerms();
    error InvalidStatus();
    error InvalidAmount();
    error CutoffPassed();
    error CutoffPending();
    error TransferFailed();

    event Funded(address indexed organizer, uint256 amount);
    event HoldPaid(address indexed recipient, uint256 amount);
    event BookingConfirmed(address indexed recipient, uint256 amount);
    event BookingExpired(address indexed recipient, uint256 amount);

    constructor(address payable venue_, uint64 cutoff_) {
        if (venue_ == address(0) || venue_ == msg.sender || cutoff_ <= block.timestamp) revert InvalidTerms();
        organizer = msg.sender;
        venue = venue_;
        cutoff = cutoff_;
    }

    modifier onlyOrganizer() {
        if (msg.sender != organizer) revert Unauthorized();
        _;
    }

    modifier beforeCutoff() {
        if (block.timestamp >= cutoff) revert CutoffPassed();
        _;
    }

    function fund() external payable onlyOrganizer beforeCutoff {
        if (status != Status.Unfunded) revert InvalidStatus();
        if (msg.value != TOTAL) revert InvalidAmount();
        status = Status.Funded;
        emit Funded(msg.sender, msg.value);
    }

    function releaseHold() external onlyOrganizer beforeCutoff {
        if (status != Status.Funded) revert InvalidStatus();
        status = Status.Held;
        _send(venue, HOLD_FEE);
        emit HoldPaid(venue, HOLD_FEE);
    }

    function confirm() external onlyOrganizer beforeCutoff {
        if (status != Status.Held) revert InvalidStatus();
        status = Status.Confirmed;
        _send(venue, BALANCE_DUE);
        emit BookingConfirmed(venue, BALANCE_DUE);
    }

    function expire() external {
        if (block.timestamp < cutoff) revert CutoffPending();
        Status previous = status;
        if (previous != Status.Funded && previous != Status.Held) revert InvalidStatus();
        status = Status.Expired;
        uint256 refund = previous == Status.Held ? BALANCE_DUE : TOTAL;
        _send(payable(organizer), refund);
        emit BookingExpired(organizer, refund);
    }

    function _send(address payable recipient, uint256 amount) private {
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
