package presenting

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/lambda"
	"github.com/aws/aws-sdk-go-v2/service/lambda/types"
)

type lambdaInvokeClient interface {
	Invoke(context.Context, *lambda.InvokeInput, ...func(*lambda.Options)) (*lambda.InvokeOutput, error)
}

type LambdaInvoker struct {
	client       lambdaInvokeClient
	functionName string
}

func NewLambdaInvoker(ctx context.Context, functionName, region string) (LambdaInvoker, error) {
	if strings.TrimSpace(functionName) == "" {
		return LambdaInvoker{}, errors.New("missing presenting renderer function name")
	}
	var options []func(*awsconfig.LoadOptions) error
	if strings.TrimSpace(region) != "" {
		options = append(options, awsconfig.WithRegion(region))
	}
	config, err := awsconfig.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return LambdaInvoker{}, err
	}
	if strings.TrimSpace(config.Region) == "" {
		return LambdaInvoker{}, errors.New("missing presenting renderer AWS region")
	}
	return LambdaInvoker{client: lambda.NewFromConfig(config), functionName: functionName}, nil
}

func (i LambdaInvoker) Invoke(ctx context.Context, input InvokeInput) error {
	if i.client == nil || input.JobID.IsZero() {
		return errors.New("presenting renderer invocation unavailable")
	}
	payload, err := json.Marshal(map[string]string{"source": "presenting", "jobId": input.JobID.String(), "capability": input.Capability, "traceparent": input.Traceparent, "tracestate": input.Tracestate})
	if err != nil {
		return fmt.Errorf("encode presenting renderer invocation: %w", err)
	}
	invocationType := types.InvocationTypeEvent
	timeout := 2 * time.Second
	if input.Synchronous {
		invocationType = types.InvocationTypeRequestResponse
		timeout = 75 * time.Second
	}
	invokeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	output, err := i.client.Invoke(invokeCtx, &lambda.InvokeInput{FunctionName: aws.String(i.functionName), InvocationType: invocationType, Payload: payload})
	if err != nil {
		return fmt.Errorf("invoke presenting renderer: %w", err)
	}
	if output == nil {
		return errors.New("invoke presenting renderer: empty response")
	}
	if input.Synchronous {
		if output.FunctionError != nil {
			return fmt.Errorf("presenting renderer failed: %s", aws.ToString(output.FunctionError))
		}
		if output.StatusCode != 200 {
			return fmt.Errorf("presenting renderer returned status %d", output.StatusCode)
		}
		return nil
	}
	if output.StatusCode != 202 {
		return fmt.Errorf("presenting renderer queue returned status %d", output.StatusCode)
	}
	return nil
}

var _ RendererInvoker = LambdaInvoker{}
