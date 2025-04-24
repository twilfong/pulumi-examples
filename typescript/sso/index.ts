import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

const config = new pulumi.Config();

// Interfaces used by stack configuration
interface PermissionSet {
  description?: string;
  sessionDuration?: string;
  awsPolicies?: string[];
  customerPolicies?: string[];
  accountAssignments: AccountAssignments;
}
interface PermisionSets {
  [name: string]: PermissionSet;
}
interface AccountAssignments {
  [group: string]: [string];
}
// interface Policies {
//   [name: string]: object;
// }

// load account name to id mapping and policy docs from stack configuration
const accountIds = config.requireObject<Record<string, string>>('accounts');
// const policyDocuments = config.requireObject<Policies>('inline-policies');

// Get the AWS SSO instance ARN and identity store ID
const ssoInstances = aws.ssoadmin.getInstances({});
// ensure exactly one instance exists
ssoInstances
  .then((instances) => {
    if (instances.arns) {
      const count = instances.arns.length;
      if (count !== 1) {
        throw new Error(`Expecting one SSO instance, but found ${count}.`);
      }
    } else {
      throw new Error('Could not retrieve SSO instances.');
    }
    if (instances.identityStoreIds) {
      const count = instances.identityStoreIds.length;
      if (count !== 1) {
        throw new Error(`Expecting one identity store, but found ${count}.`);
      }
    } else {
      throw new Error('Could not retrieve identity store.');
    }
  })
  .catch((err) => {
    console.error('Error retrieving SSO instances:', err);
  });
const instanceArn = pulumi.output(ssoInstances).arns.apply((x) => x[0]);

// Create Permission Sets defined by the stack configuration
const permissionSets = config.requireObject<PermisionSets>('permission-sets');
export const psArns: { [name: string]: pulumi.Output<string> } = {};
for (const [psName, ps] of Object.entries(permissionSets)) {
  // Create permission set first
  const { awsPolicies, customerPolicies, ...obj } = {
    name: psName,
    instanceArn: instanceArn,
    ...ps,
  };
  const pSet = new aws.ssoadmin.PermissionSet(psName, obj);
  psArns[psName] = pSet.arn;

  // Now create account assignments
  const assignments: aws.ssoadmin.AccountAssignment[] = [];
  for (const [group, accounts] of Object.entries(ps.accountAssignments)) {
    // Get the group ID from the group name and create the list of assignments
    // Note that if the number of expected groups is large, we should do a
    // single getGroups call above this to retrieve all group IDs instead
    pulumi.output(ssoInstances).identityStoreIds.apply((ids) => {
      aws.identitystore
        .getGroup({
          identityStoreId: ids[0],
          alternateIdentifier: {
            uniqueAttribute: {
              attributePath: 'DisplayName',
              attributeValue: group,
            },
          },
        })
        .then((g) => {
          for (const acnt of accounts) {
            assignments.push(
              new aws.ssoadmin.AccountAssignment(`${acnt}-${group}-${psName}`, {
                instanceArn: instanceArn,
                permissionSetArn: pSet.arn,
                principalId: g.groupId,
                principalType: 'GROUP',
                targetId: accountIds[acnt],
                targetType: 'AWS_ACCOUNT',
              }),
            );
          }
        });
    });
  }

  // Attach managed policies to permission set
  if (awsPolicies) {
    for (const policy of awsPolicies) {
      // don't think we need to preserve a ref to this attachment
      new aws.ssoadmin.ManagedPolicyAttachment(
        `${psName}-aws-${policy}`,
        {
          instanceArn: instanceArn,
          permissionSetArn: pSet.arn,
          managedPolicyArn: `arn:aws:iam::aws:policy/${policy}`,
        },
        { dependsOn: assignments }, // ensure policy attached after assignments
      );
    }
  }
  if (customerPolicies) {
    for (const policy of customerPolicies) {
      new aws.ssoadmin.CustomerManagedPolicyAttachment(
        `${psName}-custom-${policy}`,
        {
          instanceArn: instanceArn,
          permissionSetArn: pSet.arn,
          customerManagedPolicyReference: { name: policy },
        },
        { dependsOn: assignments }, // policy attached after assignments
      );
    }
  }
}
