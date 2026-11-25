// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title ReentrantAttacker — TEST ONLY.
/// @notice Malicious payee / withdrawer contracts used by
///         test/attack-battery.test.ts to prove the guard's reentrancy
///         lock holds. These contracts exist ONLY to attack the guard on
///         a throwaway local chain. NEVER deploy them to a live chain.

interface IBillPayGuard {
    function executePayment(uint256 scheduleId) external;
    function withdraw(uint256 amount) external;
    function deposit() external payable;
}

/// @notice A payee that tries to re-enter executePayment every time it is
///         paid. The reentrant call is wrapped in try/catch so the outer
///         payment still settles: the test then asserts the payment landed
///         exactly once and the re-entry never succeeded.
contract ReentrantPayee {
    IBillPayGuard public immutable guard;
    uint256 public scheduleId;
    uint256 public reentryAttempts;
    uint256 public reentrySuccesses;

    constructor(address _guard) {
        guard = IBillPayGuard(_guard);
    }

    /// @notice Point the attacker at the schedule to re-enter. Test-only.
    function arm(uint256 _scheduleId) external {
        scheduleId = _scheduleId;
    }

    receive() external payable {
        reentryAttempts += 1;
        try guard.executePayment(scheduleId) {
            reentrySuccesses += 1;
        } catch {
            // The guard refused the re-entry: exactly what the test asserts.
        }
    }
}

/// @notice A depositor that tries to re-enter withdraw() from its own
///         receive() every time it is paid out.
contract ReentrantWithdrawer {
    IBillPayGuard public immutable guard;
    uint256 public reentryAttempts;
    uint256 public reentrySuccesses;

    constructor(address _guard) {
        guard = IBillPayGuard(_guard);
    }

    function deposit() external payable {
        guard.deposit{value: msg.value}();
    }

    function attack(uint256 amount) external {
        guard.withdraw(amount);
    }

    receive() external payable {
        reentryAttempts += 1;
        try guard.withdraw(1) {
            reentrySuccesses += 1;
        } catch {
            // The guard refused the re-entry: exactly what the test asserts.
        }
    }
}
