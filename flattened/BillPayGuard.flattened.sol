// Sources flattened with hardhat v2.29.2 https://hardhat.org

// SPDX-License-Identifier: Apache-2.0

// File contracts/BillPayGuard.sol

// Original license: SPDX_License_Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title BillPayGuard
/// @notice On-chain spending guard for an autonomous bill-payment agent.
/// @dev The owner deposits funds, registers bill schedules (one allowlisted
///      payee per schedule, with per-payment and total caps, a maximum
///      payment count, a minimum interval, and an expiry), and authorises
///      one agent address. Only the owner or the authorised agent may
///      execute a payment, and only inside the schedule's limits — the
///      limits are enforced HERE, on-chain, not in the agent. The agent
///      cannot pay anyone else, cannot pay more than the caps, cannot pay
///      early, and cannot pay after expiry. The owner can change the
///      limits, revoke the agent, cancel a schedule, or withdraw unspent
///      funds at any time.
///
///      Post-quantum note: on QoreChain every EVM transaction is admitted
///      only inside a post-quantum authorisation window opened by a
///      hybrid-signed (secp256k1 + ML-DSA-87) native message. The agent's
///      payment transactions therefore require its ML-DSA-87 key: a leaked
///      ECDSA key alone cannot move funds. The window is a chain-level
///      admission rule, not contract logic, so this contract does not
///      check it — see the README.
contract BillPayGuard {
    /// @notice A recurring bill schedule. One allowlisted payee, fixed limits.
    struct Schedule {
        address owner;
        address payee;
        uint256 amountPerPayment;
        uint256 totalCap;
        uint256 maxPayments;
        uint256 intervalSeconds;
        uint256 expiry;
        uint256 paid;
        uint256 payments;
        uint256 lastPaidAt;
        bool active;
    }

    /// @notice All schedules, in creation order.
    mapping(uint256 => Schedule) public schedules;

    /// @notice Number of schedules created so far (also the next schedule id).
    uint256 public scheduleCount;

    /// @notice Deposited funds per owner. Payments draw from the owner's balance.
    mapping(address => uint256) public balances;

    /// @notice The agent address each owner has authorised (zero = none).
    mapping(address => address) public agents;

    /// @notice Total payments executed across all schedules.
    uint256 public totalPayments;

    /// @notice Total value paid out across all schedules (wei).
    uint256 public totalVolume;

    /// @notice Reentrancy lock for the functions that move funds.
    bool private locked;

    error NotOwner();
    error NotAuthorized();
    error ScheduleInactive();
    error ScheduleExpired();
    error MaxPaymentsReached();
    error TooSoon(uint256 nextEligibleAt);
    error ExceedsTotalCap();
    error InsufficientBalance();
    error InvalidPayee();
    error InvalidAmount();
    error InvalidCap();
    error InvalidMaxPayments();
    error InvalidExpiry();
    error TransferFailed();
    error Reentrancy();

    event Deposited(address indexed owner, uint256 amount, uint256 balance);
    event Withdrawn(address indexed owner, uint256 amount, uint256 balance);
    event ScheduleCreated(
        uint256 indexed scheduleId,
        address indexed owner,
        address indexed payee,
        uint256 amountPerPayment,
        uint256 totalCap,
        uint256 maxPayments,
        uint256 intervalSeconds,
        uint256 expiry
    );
    event ScheduleUpdated(
        uint256 indexed scheduleId,
        uint256 amountPerPayment,
        uint256 totalCap,
        uint256 maxPayments,
        uint256 intervalSeconds,
        uint256 expiry
    );
    event ScheduleCancelled(uint256 indexed scheduleId);
    event AgentSet(address indexed owner, address indexed agent);
    event AgentRevoked(address indexed owner);
    event PaymentExecuted(
        uint256 indexed scheduleId,
        address indexed owner,
        address indexed payee,
        uint256 amount,
        uint256 paid,
        uint256 payments
    );

    modifier nonReentrant() {
        if (locked) revert Reentrancy();
        locked = true;
        _;
        locked = false;
    }

    /// @notice Deposit funds that the owner's schedules pay from.
    function deposit() external payable {
        if (msg.value == 0) revert InvalidAmount();
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, balances[msg.sender]);
    }

    /// @notice Withdraw unspent funds.
    /// @param amount How much to withdraw (wei).
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > balances[msg.sender]) revert InvalidAmount();
        balances[msg.sender] -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount, balances[msg.sender]);
    }

    /// @notice Create a bill schedule.
    /// @param payee The ONLY address this schedule may pay (target limit).
    /// @param amountPerPayment Fixed amount per payment (value limit).
    /// @param totalCap Maximum total this schedule may ever pay (value limit).
    /// @param maxPayments Maximum number of payments (transaction limit).
    /// @param intervalSeconds Minimum seconds between payments (duration limit).
    /// @param expiry No payment after this timestamp (duration limit).
    /// @return scheduleId The new schedule's id.
    function createSchedule(
        address payee,
        uint256 amountPerPayment,
        uint256 totalCap,
        uint256 maxPayments,
        uint256 intervalSeconds,
        uint256 expiry
    ) external returns (uint256 scheduleId) {
        if (payee == address(0)) revert InvalidPayee();
        if (amountPerPayment == 0) revert InvalidAmount();
        if (totalCap < amountPerPayment) revert InvalidCap();
        if (maxPayments == 0) revert InvalidMaxPayments();
        if (expiry <= block.timestamp) revert InvalidExpiry();

        scheduleId = scheduleCount;
        scheduleCount += 1;
        schedules[scheduleId] = Schedule({
            owner: msg.sender,
            payee: payee,
            amountPerPayment: amountPerPayment,
            totalCap: totalCap,
            maxPayments: maxPayments,
            intervalSeconds: intervalSeconds,
            expiry: expiry,
            paid: 0,
            payments: 0,
            lastPaidAt: 0,
            active: true
        });
        emit ScheduleCreated(
            scheduleId,
            msg.sender,
            payee,
            amountPerPayment,
            totalCap,
            maxPayments,
            intervalSeconds,
            expiry
        );
        return scheduleId;
    }

    /// @notice Change a schedule's limits. Only the owner. New caps must
    ///         still cover what has already been paid.
    function updateSchedule(
        uint256 scheduleId,
        uint256 amountPerPayment,
        uint256 totalCap,
        uint256 maxPayments,
        uint256 intervalSeconds,
        uint256 expiry
    ) external {
        Schedule storage s = schedules[scheduleId];
        if (msg.sender != s.owner) revert NotOwner();
        if (!s.active) revert ScheduleInactive();
        if (amountPerPayment == 0) revert InvalidAmount();
        if (totalCap < s.paid || totalCap < amountPerPayment) revert InvalidCap();
        if (maxPayments < s.payments || maxPayments == 0) revert InvalidMaxPayments();
        if (expiry <= block.timestamp) revert InvalidExpiry();
        s.amountPerPayment = amountPerPayment;
        s.totalCap = totalCap;
        s.maxPayments = maxPayments;
        s.intervalSeconds = intervalSeconds;
        s.expiry = expiry;
        emit ScheduleUpdated(scheduleId, amountPerPayment, totalCap, maxPayments, intervalSeconds, expiry);
    }

    /// @notice Cancel a schedule. Only the owner. Paid funds stay paid;
    ///         no further payment is possible.
    function cancelSchedule(uint256 scheduleId) external {
        Schedule storage s = schedules[scheduleId];
        if (msg.sender != s.owner) revert NotOwner();
        if (!s.active) revert ScheduleInactive();
        s.active = false;
        emit ScheduleCancelled(scheduleId);
    }

    /// @notice Authorise the agent address allowed to execute this owner's
    ///         payments. Only one agent at a time; setting a new one
    ///         replaces the old one.
    function setAgent(address agent) external {
        if (agent == address(0)) revert NotAuthorized();
        agents[msg.sender] = agent;
        emit AgentSet(msg.sender, agent);
    }

    /// @notice Revoke the owner's agent. The owner can still execute
    ///         payments directly.
    function revokeAgent() external {
        agents[msg.sender] = address(0);
        emit AgentRevoked(msg.sender);
    }

    /// @notice Execute one payment of a schedule. Only the owner or the
    ///         owner's authorised agent. Every limit is checked here.
    /// @param scheduleId The schedule to pay.
    function executePayment(uint256 scheduleId) external nonReentrant {
        Schedule storage s = schedules[scheduleId];
        if (msg.sender != s.owner && msg.sender != agents[s.owner]) revert NotAuthorized();
        if (!s.active) revert ScheduleInactive();
        if (block.timestamp > s.expiry) revert ScheduleExpired();
        if (s.payments >= s.maxPayments) revert MaxPaymentsReached();
        if (block.timestamp < s.lastPaidAt + s.intervalSeconds) {
            revert TooSoon(s.lastPaidAt + s.intervalSeconds);
        }
        if (s.paid + s.amountPerPayment > s.totalCap) revert ExceedsTotalCap();
        if (balances[s.owner] < s.amountPerPayment) revert InsufficientBalance();

        balances[s.owner] -= s.amountPerPayment;
        s.paid += s.amountPerPayment;
        s.payments += 1;
        s.lastPaidAt = block.timestamp;
        totalPayments += 1;
        totalVolume += s.amountPerPayment;

        (bool ok, ) = s.payee.call{value: s.amountPerPayment}("");
        if (!ok) revert TransferFailed();

        emit PaymentExecuted(scheduleId, s.owner, s.payee, s.amountPerPayment, s.paid, s.payments);
    }

    /// @notice Whether a schedule is due right now, and why not if it isn't.
    ///         The agent runner calls this before sending a transaction, so
    ///         it never wastes gas on a payment the contract would reject.
    /// @return due True when a payment would succeed right now.
    /// @return reason Short machine-readable reason ("due", "inactive",
    ///         "expired", "max-payments", "too-soon", "cap-reached",
    ///         "insufficient-balance").
    function checkDue(uint256 scheduleId) external view returns (bool due, string memory reason) {
        Schedule storage s = schedules[scheduleId];
        if (!s.active) return (false, "inactive");
        if (block.timestamp > s.expiry) return (false, "expired");
        if (s.payments >= s.maxPayments) return (false, "max-payments");
        if (block.timestamp < s.lastPaidAt + s.intervalSeconds) return (false, "too-soon");
        if (s.paid + s.amountPerPayment > s.totalCap) return (false, "cap-reached");
        if (balances[s.owner] < s.amountPerPayment) return (false, "insufficient-balance");
        return (true, "due");
    }

    /// @notice A schedule's full state (a convenience wrapper over `schedules`).
    function getSchedule(uint256 scheduleId) external view returns (Schedule memory) {
        return schedules[scheduleId];
    }
}
