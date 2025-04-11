import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// Create custom policies
// Get the policy documents from the stack configuration
interface Policies { [name: string]: any };
const config = new pulumi.Config();
const policyDocuments = config.requireObject<Policies>("policies");
export const policyArns: { [name: string]: pulumi.Output<string> } = {};
for (const [name, doc] of Object.entries(policyDocuments)) {
    const policy = new aws.iam.Policy(name, {
        name: name,
        policy: JSON.stringify(doc),
    });
    policyArns[name] = policy.arn;
};
